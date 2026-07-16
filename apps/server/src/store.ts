import Database from "better-sqlite3";

/**
 * 加密 blob 儲存層:伺服器只見 doc id 與密文,不解讀內容
 * updates 是每 doc 的 append-only 增量日誌,seq 由伺服器配發
 * snapshots 存 client 產生的全量快照,涵蓋的增量隨即截斷
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  doc_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_by_vault ON docs (vault_id);
CREATE TABLE IF NOT EXISTS updates (
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  counter INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (doc_id, seq),
  UNIQUE (doc_id, device_id, counter)
);
CREATE TABLE IF NOT EXISTS snapshots (
  doc_id TEXT PRIMARY KEY,
  upto_seq INTEGER NOT NULL,
  payload BLOB NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

/** doc 已隸屬其他 vault:呼叫端據此回覆 forbidden 而非 internal */
export class VaultMismatchError extends Error {}

export interface StoredUpdate {
  seq: number;
  payload: Uint8Array;
}

export interface StoredSnapshot {
  uptoSeq: number;
  payload: Uint8Array;
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
      this.claimDoc(vaultId, docId);
      const existing = this.db
        .prepare("SELECT seq FROM updates WHERE doc_id = ? AND device_id = ? AND counter = ?")
        .get(docId, deviceId, counter) as { seq: number } | undefined;
      if (existing) return existing.seq;
      const seq = this.headSeq(docId) + 1;
      this.db
        .prepare("INSERT INTO updates (doc_id, seq, device_id, counter, payload) VALUES (?, ?, ?, ?, ?)")
        .run(docId, seq, deviceId, counter, payload);
      return seq;
    });
    return append();
  }

  updatesSince(vaultId: string, docId: string, fromSeq: number): StoredUpdate[] {
    if (!this.docInVault(vaultId, docId)) return [];
    const rows = this.db
      .prepare("SELECT seq, payload FROM updates WHERE doc_id = ? AND seq > ? ORDER BY seq")
      .all(docId, fromSeq) as Array<{ seq: number; payload: Buffer }>;
    return rows.map((r) => ({ seq: r.seq, payload: new Uint8Array(r.payload) }));
  }

  /** 存快照並截斷已涵蓋的增量;舊於現有快照點的直接忽略 */
  saveSnapshot(vaultId: string, docId: string, uptoSeq: number, payload: Uint8Array): void {
    const save = this.db.transaction(() => {
      this.claimDoc(vaultId, docId);
      const current = this.db.prepare("SELECT upto_seq FROM snapshots WHERE doc_id = ?").get(docId) as
        | { upto_seq: number }
        | undefined;
      if (current && current.upto_seq >= uptoSeq) return;
      this.db
        .prepare(
          "INSERT INTO snapshots (doc_id, upto_seq, payload) VALUES (?, ?, ?) " +
            "ON CONFLICT (doc_id) DO UPDATE SET upto_seq = excluded.upto_seq, payload = excluded.payload, created_at = unixepoch()",
        )
        .run(docId, uptoSeq, payload);
      this.db.prepare("DELETE FROM updates WHERE doc_id = ? AND seq <= ?").run(docId, uptoSeq);
    });
    save();
  }

  snapshot(vaultId: string, docId: string): StoredSnapshot | undefined {
    if (!this.docInVault(vaultId, docId)) return undefined;
    const row = this.db.prepare("SELECT upto_seq, payload FROM snapshots WHERE doc_id = ?").get(docId) as
      | { upto_seq: number; payload: Buffer }
      | undefined;
    return row && { uptoSeq: row.upto_seq, payload: new Uint8Array(row.payload) };
  }

  /** vault 內每個 doc 的最新 seq 與快照點,client 據此決定要 pull 什麼 */
  headSeqs(vaultId: string): Array<{ docId: string; headSeq: number; snapshotSeq: number }> {
    const rows = this.db
      .prepare(
        `SELECT d.doc_id AS docId,
                MAX(COALESCE((SELECT MAX(seq) FROM updates u WHERE u.doc_id = d.doc_id), 0),
                    COALESCE((SELECT upto_seq FROM snapshots s WHERE s.doc_id = d.doc_id), 0)) AS headSeq,
                COALESCE((SELECT upto_seq FROM snapshots s WHERE s.doc_id = d.doc_id), 0) AS snapshotSeq
         FROM docs d WHERE d.vault_id = ? ORDER BY d.doc_id`,
      )
      .all(vaultId) as Array<{ docId: string; headSeq: number; snapshotSeq: number }>;
    return rows;
  }

  close(): void {
    this.db.close();
  }

  /** doc 首次出現時綁定 vault;已隸屬其他 vault 則拒絕,防跨 vault 寫入 */
  private claimDoc(vaultId: string, docId: string): void {
    const owner = this.db.prepare("SELECT vault_id FROM docs WHERE doc_id = ?").get(docId) as
      | { vault_id: string }
      | undefined;
    if (!owner) {
      this.db.prepare("INSERT INTO docs (doc_id, vault_id) VALUES (?, ?)").run(docId, vaultId);
      return;
    }
    if (owner.vault_id !== vaultId) throw new VaultMismatchError(`doc 隸屬其他 vault:${docId}`);
  }

  private docInVault(vaultId: string, docId: string): boolean {
    const owner = this.db.prepare("SELECT vault_id FROM docs WHERE doc_id = ?").get(docId) as
      | { vault_id: string }
      | undefined;
    return owner?.vault_id === vaultId;
  }

  /** 快照截斷後 MAX(updates.seq) 會消失,head 必須同時看快照點 */
  private headSeq(docId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(COALESCE((SELECT MAX(seq) FROM updates WHERE doc_id = $doc), 0),
                    COALESCE((SELECT upto_seq FROM snapshots WHERE doc_id = $doc), 0)) AS head`,
      )
      .get({ doc: docId }) as { head: number };
    return row.head;
  }
}
