import Database from "better-sqlite3";
import type { SharePermission, ShareInfo } from "@stele/sync";

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
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS shares_by_vault ON shares (vault_id);
`;

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

export class SyncStore {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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

  /** 存快照並截斷已涵蓋的增量;舊於現有快照點的直接忽略 */
  saveSnapshot(vaultId: string, docId: string, uptoSeq: number, payload: Uint8Array): void {
    const save = this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO docs (vault_id, doc_id) VALUES (?, ?)").run(vaultId, docId);
      const current = this.db
        .prepare("SELECT upto_seq FROM snapshots WHERE vault_id = ? AND doc_id = ?")
        .get(vaultId, docId) as { upto_seq: number } | undefined;
      if (current && current.upto_seq >= uptoSeq) return;
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

  /** 建立分享:shareId 由伺服器產生的不可猜亂數,擁有者的憑證(可否分享)由 vault 認證把關 */
  createShare(shareId: string, vaultId: string, docId: string, permission: SharePermission, expiresAt?: number): void {
    this.db
      .prepare("INSERT INTO shares (share_id, vault_id, doc_id, permission, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(shareId, vaultId, docId, permission, expiresAt ?? null);
  }

  /** 解析分享作用域;已撤銷或已過期一律視為不存在,收件人得到的是查無此分享 */
  resolveShare(shareId: string): ShareScope | undefined {
    const row = this.db
      .prepare(
        "SELECT vault_id, doc_id, permission FROM shares " +
          "WHERE share_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > unixepoch())",
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
