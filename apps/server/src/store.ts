import Database from "better-sqlite3";
import type { SharePermission, ShareInfo, KeyEnvelope, MemberRole } from "@stele/sync";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 加密 blob 儲存層:伺服器只見 doc id 與密文,不解讀內容
 * doc 命名空間按 vault 隔離(composite key):不同 vault 的同名 doc 互不相干,
 * 也不可能跨 vault 探測或搶占 doc id;固定名稱的 meta doc(vault-meta)因此安全
 * updates 是每 doc 的 append-only 增量日誌,seq 由伺服器配發
 * snapshots 存 client 產生的全量快照,涵蓋的增量隨即截斷
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  vault_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, doc_id)
);
CREATE TABLE IF NOT EXISTS updates (
  vault_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  counter INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, doc_id, seq),
  UNIQUE (vault_id, doc_id, device_id, counter)
);
CREATE TABLE IF NOT EXISTS snapshots (
  vault_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  upto_seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, doc_id)
);
CREATE TABLE IF NOT EXISTS shares (
  share_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS shares_by_vault ON shares (vault_id);
CREATE TABLE IF NOT EXISTS members (
  vault_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  pub_sign BLOB NOT NULL,
  pub_wrap BLOB NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, member_id)
);
CREATE TABLE IF NOT EXISTS vault_owners (
  vault_id TEXT PRIMARY KEY,
  owner_member_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS key_envelopes (
  vault_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 0,
  wrapped_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, key_id, member_id, epoch)
);
CREATE TABLE IF NOT EXISTS role_credentials (
  vault_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  blob BLOB NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, member_id)
);
CREATE TABLE IF NOT EXISTS member_certs (
  vault_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  blob BLOB NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (vault_id, member_id)
);
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  expires_at INTEGER,
  used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

/** 對既有 DB 補欄:2c 的 role、2c-2 的 epoch;欄已存在時 ALTER 失敗即忽略(冪等遷移) */
function migrateRoles(db: Database.Database): void {
  for (const sql of [
    "ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
    "ALTER TABLE enrollment_tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'viewer'",
    "ALTER TABLE vault_owners ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE shares ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // 欄位已存在(新建 DB 已含,或先前已遷移)——冪等,無妨
    }
  }
}

export interface StoredUpdate {
  seq: number;
  payload: Uint8Array;
}

export interface StoredSnapshot {
  uptoSeq: number;
  payload: Uint8Array;
}

/** 分享一經解析出的作用域:連線被鎖定在這個 vault 的單一 doc 與權限 */
export interface ShareScope {
  vaultId: string;
  docId: string;
  permission: SharePermission;
}

/** 某 vault 的一位成員(公開資料 + 角色);2c 起 role 成為伺服器授權邊界 */
export interface MemberRecord {
  memberId: string;
  pubSign: Uint8Array;
  pubWrap: Uint8Array;
  role: MemberRole;
  /** 是否已持有任一金鑰信封(2c-2):false = 待 owner 核准;輪換只重包已核准者 */
  approved: boolean;
}

export class SyncStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    migrateRoles(this.db);
  }

  /** 配發下一個 seq 並入庫;同一 device+counter 重送回傳既有 seq,冪等 */
  appendUpdate(vaultId: string, docId: string, deviceId: string, counter: number, payload: Uint8Array): number {
    const append = this.db.transaction((): number => {
      this.db.prepare("INSERT OR IGNORE INTO docs (vault_id, doc_id) VALUES (?, ?)").run(vaultId, docId);
      const existing = this.db
        .prepare("SELECT seq FROM updates WHERE vault_id = ? AND doc_id = ? AND device_id = ? AND counter = ?")
        .get(vaultId, docId, deviceId, counter) as { seq: number } | undefined;
      if (existing) return existing.seq;
      const seq = this.headSeq(vaultId, docId) + 1;
      this.db
        .prepare("INSERT INTO updates (vault_id, doc_id, seq, device_id, counter, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(vaultId, docId, seq, deviceId, counter, payload);
      return seq;
    });
    return append();
  }

  updatesSince(vaultId: string, docId: string, fromSeq: number): StoredUpdate[] {
    const rows = this.db
      .prepare("SELECT seq, payload FROM updates WHERE vault_id = ? AND doc_id = ? AND seq > ? ORDER BY seq")
      .all(vaultId, docId, fromSeq) as Array<{ seq: number; payload: Buffer }>;
    return rows.map((r) => ({ seq: r.seq, payload: new Uint8Array(r.payload) }));
  }

  /**
   * 存快照並截斷已涵蓋的增量;嚴格舊於現有快照點的忽略。
   * **同一快照點覆蓋**:同 upto 的快照內容等價(同一序列前綴),但金鑰可能不同——
   * 輪換重加密撞上既有快照點時必須以新密文為準,否則 rekey 被靜默忽略,舊金鑰快照留存即安全洞。
   */
  saveSnapshot(vaultId: string, docId: string, uptoSeq: number, payload: Uint8Array): void {
    const save = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO docs (vault_id, doc_id) VALUES (?, ?)").run(vaultId, docId);
      const current = this.db
        .prepare("SELECT upto_seq FROM snapshots WHERE vault_id = ? AND doc_id = ?")
        .get(vaultId, docId) as { upto_seq: number } | undefined;
      if (current && current.upto_seq > uptoSeq) return;
      this.db
        .prepare(
          "INSERT INTO snapshots (vault_id, doc_id, upto_seq, payload) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT (vault_id, doc_id) DO UPDATE SET upto_seq = excluded.upto_seq, payload = excluded.payload, created_at = unixepoch()",
        )
        .run(vaultId, docId, uptoSeq, payload);
      this.db.prepare("DELETE FROM updates WHERE vault_id = ? AND doc_id = ? AND seq <= ?").run(vaultId, docId, uptoSeq);
    });
    save();
  }

  snapshot(vaultId: string, docId: string): StoredSnapshot | undefined {
    const row = this.db
      .prepare("SELECT upto_seq, payload FROM snapshots WHERE vault_id = ? AND doc_id = ?")
      .get(vaultId, docId) as { upto_seq: number; payload: Buffer } | undefined;
    return row && { uptoSeq: row.upto_seq, payload: new Uint8Array(row.payload) };
  }

  /** vault 內每個 doc 的最新 seq 與快照點,client 據此決定要 pull 什麼 */
  headSeqs(vaultId: string): Array<{ docId: string; headSeq: number; snapshotSeq: number }> {
    const rows = this.db
      .prepare(
        `SELECT d.doc_id AS docId,
                MAX(COALESCE((SELECT MAX(seq) FROM updates u WHERE u.vault_id = d.vault_id AND u.doc_id = d.doc_id), 0),
                    COALESCE((SELECT upto_seq FROM snapshots s WHERE s.vault_id = d.vault_id AND s.doc_id = d.doc_id), 0)) AS headSeq,
                COALESCE((SELECT upto_seq FROM snapshots s WHERE s.vault_id = d.vault_id AND s.doc_id = d.doc_id), 0) AS snapshotSeq
         FROM docs d WHERE d.vault_id = ? ORDER BY d.doc_id`,
      )
      .all(vaultId) as Array<{ docId: string; headSeq: number; snapshotSeq: number }>;
    return rows;
  }

  /** 建立分享:shareId 由伺服器產生的不可猜亂數,綁建立當下的 vault epoch(輪換後金鑰已換,舊連結作廢) */
  createShare(shareId: string, vaultId: string, docId: string, permission: SharePermission, expiresAt?: number): void {
    this.db
      .prepare("INSERT INTO shares (share_id, vault_id, doc_id, permission, expires_at, epoch) VALUES (?, ?, ?, ?, ?, ?)")
      .run(shareId, vaultId, docId, permission, expiresAt ?? null, this.epochOf(vaultId));
  }

  /** 解析分享作用域;已撤銷、已過期或建立後 vault 已輪換金鑰,一律視為不存在 */
  resolveShare(shareId: string): ShareScope | undefined {
    const row = this.db
      .prepare(
        "SELECT vault_id, doc_id, permission FROM shares s " +
          "WHERE share_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > unixepoch()) " +
          "AND epoch = COALESCE((SELECT epoch FROM vault_owners vo WHERE vo.vault_id = s.vault_id), 0)",
      )
      .get(shareId) as { vault_id: string; doc_id: string; permission: SharePermission } | undefined;
    return row && { vaultId: row.vault_id, docId: row.doc_id, permission: row.permission };
  }

  /** 撤銷分享;限本 vault,避免猜到他人 shareId 就能撤銷 */
  /** 回傳是否真的撤銷到:vault 不符時為 false,呼叫端據此決定要不要踢連線,免得跨 vault 誤踢 */
  revokeShare(vaultId: string, shareId: string): boolean {
    const info = this.db.prepare("UPDATE shares SET revoked = 1 WHERE share_id = ? AND vault_id = ?").run(shareId, vaultId);
    return info.changes > 0;
  }

  /** 列出某 vault 的所有分享(含已撤銷,擁有者需看得到歷史) */
  listShares(vaultId: string): ShareInfo[] {
    const rows = this.db
      .prepare("SELECT share_id, doc_id, permission, revoked FROM shares WHERE vault_id = ? ORDER BY created_at DESC")
      .all(vaultId) as Array<{ share_id: string; doc_id: string; permission: SharePermission; revoked: number }>;
    return rows.map((r) => ({ shareId: r.share_id, docId: r.doc_id, permission: r.permission, revoked: r.revoked === 1 }));
  }

  /**
   * 成員入表(TOFU 公鑰釘選):
   * - 首見 (vault,member) → INSERT
   * - 再見且 pub_sign 相同 → 更新 last_seen,回 "ok"
   * - 再見但 pub_sign 不同 → "conflict"(擋冒名/覆蓋),不改任何列
   * Slice 2a 是自註冊、advisory;釘選是唯一現在就給的硬保證,為 2c 留可信起點。
   * role(2c):首見時以邀請碼帶來的 role 入表;再見既有成員不動其 role(改角色走 setRole)。
   */
  enrollMember(vaultId: string, memberId: string, pubSign: Uint8Array, pubWrap: Uint8Array, role: MemberRole): "ok" | "conflict" {
    const enroll = this.db.transaction((): "ok" | "conflict" => {
      const existing = this.db
        .prepare("SELECT pub_sign FROM members WHERE vault_id = ? AND member_id = ?")
        .get(vaultId, memberId) as { pub_sign: Buffer } | undefined;
      if (existing) {
        if (!bytesEqual(new Uint8Array(existing.pub_sign), pubSign)) return "conflict";
        this.db
          .prepare("UPDATE members SET last_seen = unixepoch() WHERE vault_id = ? AND member_id = ?")
          .run(vaultId, memberId);
        return "ok";
      }
      this.db
        .prepare("INSERT INTO members (vault_id, member_id, pub_sign, pub_wrap, role) VALUES (?, ?, ?, ?, ?)")
        .run(vaultId, memberId, Buffer.from(pubSign), Buffer.from(pubWrap), role);
      return "ok";
    });
    return enroll();
  }

  getMember(vaultId: string, memberId: string): MemberRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT member_id, pub_sign, pub_wrap, role,
                EXISTS(SELECT 1 FROM key_envelopes e WHERE e.vault_id = members.vault_id AND e.member_id = members.member_id) AS approved
         FROM members WHERE vault_id = ? AND member_id = ?`,
      )
      .get(vaultId, memberId) as { member_id: string; pub_sign: Buffer; pub_wrap: Buffer; role: MemberRole; approved: number } | undefined;
    return (
      row && {
        memberId: row.member_id,
        pubSign: new Uint8Array(row.pub_sign),
        pubWrap: new Uint8Array(row.pub_wrap),
        role: row.role,
        approved: row.approved === 1,
      }
    );
  }

  /** 某成員角色;查無此成員回 undefined(供逐訊息授權) */
  roleOf(vaultId: string, memberId: string): MemberRole | undefined {
    const row = this.db
      .prepare("SELECT role FROM members WHERE vault_id = ? AND member_id = ?")
      .get(vaultId, memberId) as { role: MemberRole } | undefined;
    return row?.role;
  }

  /** 設某成員角色(owner-only,授權在 server 層把關);回傳是否確有此成員 */
  setRole(vaultId: string, memberId: string, role: MemberRole): boolean {
    const info = this.db.prepare("UPDATE members SET role = ? WHERE vault_id = ? AND member_id = ?").run(role, vaultId, memberId);
    return info.changes > 0;
  }

  /** 列出某 vault 全部成員(含角色與是否已核准),供 owner 管理與包裝金鑰時查對方 wrap 公鑰 */
  listMembers(vaultId: string): MemberRecord[] {
    const rows = this.db
      .prepare(
        `SELECT member_id, pub_sign, pub_wrap, role,
                EXISTS(SELECT 1 FROM key_envelopes e WHERE e.vault_id = m.vault_id AND e.member_id = m.member_id) AS approved
         FROM members m WHERE vault_id = ? ORDER BY first_seen`,
      )
      .all(vaultId) as Array<{ member_id: string; pub_sign: Buffer; pub_wrap: Buffer; role: MemberRole; approved: number }>;
    return rows.map((r) => ({
      memberId: r.member_id,
      pubSign: new Uint8Array(r.pub_sign),
      pubWrap: new Uint8Array(r.pub_wrap),
      role: r.role,
      approved: r.approved === 1,
    }));
  }

  /** 移除成員:刪 member 列 + 其所有金鑰信封、角色憑證與成員憑證(密碼層前向保密由呼叫端接著輪換補上) */
  removeMember(vaultId: string, memberId: string): void {
    const remove = this.db.transaction(() => {
      this.db.prepare("DELETE FROM members WHERE vault_id = ? AND member_id = ?").run(vaultId, memberId);
      this.db.prepare("DELETE FROM key_envelopes WHERE vault_id = ? AND member_id = ?").run(vaultId, memberId);
      this.db.prepare("DELETE FROM role_credentials WHERE vault_id = ? AND member_id = ?").run(vaultId, memberId);
      this.db.prepare("DELETE FROM member_certs WHERE vault_id = ? AND member_id = ?").run(vaultId, memberId);
    });
    remove();
  }

  /** 存某成員的角色憑證(owner 簽章 blob,伺服器只中繼不解讀;upsert 冪等) */
  putRoleCredential(vaultId: string, memberId: string, blob: Uint8Array): void {
    this.db
      .prepare(
        "INSERT INTO role_credentials (vault_id, member_id, blob) VALUES (?, ?, ?) " +
          "ON CONFLICT (vault_id, member_id) DO UPDATE SET blob = excluded.blob, updated_at = unixepoch()",
      )
      .run(vaultId, memberId, Buffer.from(blob));
  }

  /** 某成員的角色憑證;未簽發回 undefined */
  roleCredentialFor(vaultId: string, memberId: string): Uint8Array | undefined {
    const row = this.db
      .prepare("SELECT blob FROM role_credentials WHERE vault_id = ? AND member_id = ?")
      .get(vaultId, memberId) as { blob: Buffer } | undefined;
    return row && new Uint8Array(row.blob);
  }

  /** 存某成員的成員憑證(owner 背書 memberId↔pubSign 的 blob;P4 寫入真實性;upsert 冪等) */
  putMemberCert(vaultId: string, memberId: string, blob: Uint8Array): void {
    this.db
      .prepare(
        "INSERT INTO member_certs (vault_id, member_id, blob) VALUES (?, ?, ?) " +
          "ON CONFLICT (vault_id, member_id) DO UPDATE SET blob = excluded.blob, updated_at = unixepoch()",
      )
      .run(vaultId, memberId, Buffer.from(blob));
  }

  /** 全 vault 的成員憑證目錄(任何成員可拉,驗他人寫入作者用);blob 自帶 owner 簽章 */
  listMemberCerts(vaultId: string): Uint8Array[] {
    const rows = this.db
      .prepare("SELECT blob FROM member_certs WHERE vault_id = ? ORDER BY member_id")
      .all(vaultId) as Array<{ blob: Buffer }>;
    return rows.map((r) => new Uint8Array(r.blob));
  }

  /**
   * 認領 vault 擁有者(TOFU):首位認領者寫入並釘選,之後認領一律回傳既有 owner(不覆蓋)。
   * 回傳認領後該 vault 的實際 owner memberId。owner 存在 = 此 vault 為 team vault。
   */
  claimOwner(vaultId: string, memberId: string): string {
    const claim = this.db.transaction((): string => {
      const existing = this.db
        .prepare("SELECT owner_member_id FROM vault_owners WHERE vault_id = ?")
        .get(vaultId) as { owner_member_id: string } | undefined;
      if (existing) return existing.owner_member_id;
      this.db.prepare("INSERT INTO vault_owners (vault_id, owner_member_id) VALUES (?, ?)").run(vaultId, memberId);
      // 認領者角色即 owner(創建者 enroll 時無邀請碼 → 預設 viewer,claim 時升 owner)
      this.db.prepare("UPDATE members SET role = 'owner' WHERE vault_id = ? AND member_id = ?").run(vaultId, memberId);
      return memberId;
    });
    return claim();
  }

  /** 某 vault 的 owner memberId;undefined = 非 team vault(個人/legacy) */
  ownerOf(vaultId: string): string | undefined {
    const row = this.db
      .prepare("SELECT owner_member_id FROM vault_owners WHERE vault_id = ?")
      .get(vaultId) as { owner_member_id: string } | undefined;
    return row?.owner_member_id;
  }

  /** vault 當前金鑰紀元(2c-2);非 team vault 恆 0 */
  epochOf(vaultId: string): number {
    const row = this.db.prepare("SELECT epoch FROM vault_owners WHERE vault_id = ?").get(vaultId) as { epoch: number } | undefined;
    return row?.epoch ?? 0;
  }

  /**
   * 輪換 commit(CAS):僅當 next 恰為當前 epoch+1 才 bump,回傳是否成功。
   * 併發或重放下只有一次成功——epoch 是柵欄的真相來源,絕不跳號或回捲。
   */
  bumpEpoch(vaultId: string, next: number): boolean {
    const info = this.db.prepare("UPDATE vault_owners SET epoch = ? WHERE vault_id = ? AND epoch = ?").run(next, vaultId, next - 1);
    return info.changes > 0;
  }

  /** 存一封金鑰信封(upsert 冪等:owner 重 wrap 同一 (vault,key,member,epoch) 直接覆蓋) */
  putEnvelope(vaultId: string, keyId: string, memberId: string, epoch: number, blob: Uint8Array): void {
    this.db
      .prepare(
        "INSERT INTO key_envelopes (vault_id, key_id, member_id, epoch, wrapped_blob) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (vault_id, key_id, member_id, epoch) DO UPDATE SET wrapped_blob = excluded.wrapped_blob, created_at = unixepoch()",
      )
      .run(vaultId, keyId, memberId, epoch, Buffer.from(blob));
  }

  /**
   * 當前紀元存在 per-space 信封的空間 id(= 受限空間集合;伺服器只見 id 不解內容)。
   * 隨 envelopeList 原子發給成員:受限與否的判定不依賴 vault-meta 名單的同步時序。
   * 恢復開放的空間在下一輪輪換後不再有新紀元信封,自動退出清單。
   */
  restrictedSpaceIds(vaultId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT key_id FROM key_envelopes
         WHERE vault_id = $vault AND key_id != 'root'
           AND epoch = COALESCE((SELECT epoch FROM vault_owners WHERE vault_id = $vault), 0)
         ORDER BY key_id`,
      )
      .all({ vault: vaultId }) as Array<{ key_id: string }>;
    return rows.map((r) => r.key_id);
  }

  /** 取某成員在此 vault 的金鑰信封:每個 key_id 只回最新 epoch(2b epoch 恆 0;輪換語義留 2c) */
  envelopesFor(vaultId: string, memberId: string): KeyEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT key_id, epoch, wrapped_blob FROM key_envelopes e
         WHERE vault_id = ? AND member_id = ?
           AND epoch = (SELECT MAX(epoch) FROM key_envelopes
                        WHERE vault_id = e.vault_id AND key_id = e.key_id AND member_id = e.member_id)
         ORDER BY key_id`,
      )
      .all(vaultId, memberId) as Array<{ key_id: string; epoch: number; wrapped_blob: Buffer }>;
    return rows.map((r) => ({ keyId: r.key_id, epoch: r.epoch, blob: new Uint8Array(r.wrapped_blob) }));
  }

  /** 建立一次性邀請碼(綁 vault + 加入後角色、可設有效期);token 由呼叫端產生的不可猜亂數 */
  createEnrollmentToken(token: string, vaultId: string, role: MemberRole, expiresAt?: number): void {
    this.db
      .prepare("INSERT INTO enrollment_tokens (token, vault_id, role, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, vaultId, role, expiresAt ?? null);
  }

  /**
   * 消耗邀請碼:僅當 token 存在、未用、未過期且綁的正是此 vault 時,標記已用並回其 role;否則 undefined。
   * 單次性由 UPDATE ... WHERE used = 0 的 changes 保證,並發下只有一次成功;RETURNING 取回該碼指定的角色。
   */
  consumeEnrollmentToken(token: string, vaultId: string): MemberRole | undefined {
    const row = this.db
      .prepare(
        "UPDATE enrollment_tokens SET used = 1 " +
          "WHERE token = ? AND vault_id = ? AND used = 0 AND (expires_at IS NULL OR expires_at > unixepoch()) " +
          "RETURNING role",
      )
      .get(token, vaultId) as { role: MemberRole } | undefined;
    return row?.role;
  }

  close(): void {
    this.db.close();
  }

  /** 快照截斷後 MAX(updates.seq) 會消失,head 必須同時看快照點 */
  private headSeq(vaultId: string, docId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE((SELECT MAX(seq) FROM updates WHERE vault_id = $vault AND doc_id = $doc), 0),
                    COALESCE((SELECT upto_seq FROM snapshots WHERE vault_id = $vault AND doc_id = $doc), 0)) AS head`,
      )
      .get({ vault: vaultId, doc: docId }) as { head: number };
    return row.head;
  }
}
