import * as Y from "yjs";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import {
  SyncClient,
  type Cipher,
  type SocketLike,
  type SyncDocState,
  type SyncHost,
  type SyncStatus,
} from "@stele/sync";
import type { VaultSession, VaultFileEvent } from "./vault-session.ts";

/**
 * 把 VaultSession 接上 SyncClient:
 * - 路徑 LWW = meta doc(保留 id vault-meta)的 Y.Map:docId → 相對路徑
 * - 本地檔案生滅 → 改 map;遠端 map 變更 → 落地為改名/物化/進回收桶
 * - 遠端新 doc 內容先進 loose 池,等 meta 路徑到齊再物化成檔案
 */

export const META_DOC_ID = "vault-meta";

/** 筆記 doc id 必須是 UUID:meta 的 key 來自遠端,寬鬆放行就是路徑穿越面 */
const NOTE_DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SyncSettings {
  url: string;
  token: string;
  vaultId: string;
  deviceId: string;
}

interface PersistedDocState {
  lastSeq: number;
  counter: number;
  syncedSv?: string;
}

const SAVE_DEBOUNCE_MS = 200;

export class SyncManager {
  private readonly meta = new Y.Doc();
  private readonly paths: Y.Map<string>;
  private readonly loose = new Map<string, Y.Doc>();
  private readonly states = new Map<string, SyncDocState>();
  private readonly client: SyncClient;
  private readonly unsubscribeFiles: () => void;
  private readonly metaFile: string;
  private readonly stateFile: string;
  private metaTimer: NodeJS.Timeout | undefined;
  private stateTimer: NodeJS.Timeout | undefined;
  /** 檔案系統操作依序執行,遠端 meta 變更不互相踩腳 */
  private fsOps: Promise<void> = Promise.resolve();
  status: SyncStatus = "offline";

  constructor(
    private readonly session: VaultSession,
    settings: SyncSettings,
    private readonly onStatus?: (status: SyncStatus) => void,
    tuning?: { pushDebounceMs?: number; snapshotThreshold?: number; cipher?: Cipher },
  ) {
    this.metaFile = path.join(session.root, ".stele", "meta.ybin");
    this.stateFile = path.join(session.root, ".stele", "sync-state.json");
    this.paths = this.meta.getMap("paths");
    this.loadMeta();
    this.loadStates();

    this.meta.on("update", () => this.scheduleMetaSave());
    this.paths.observe((event, tx) => {
      if (tx.origin === "sync") this.applyRemoteMeta(Array.from(event.keysChanged as Set<string>));
    });

    this.client = new SyncClient({
      url: settings.url,
      token: settings.token,
      vaultId: settings.vaultId,
      deviceId: settings.deviceId,
      host: this.makeHost(),
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onStatus: (status) => {
        this.status = status;
        this.onStatus?.(status);
      },
      pushDebounceMs: tuning?.pushDebounceMs,
      snapshotThreshold: tuning?.snapshotThreshold,
      cipher: tuning?.cipher,
    });
    this.unsubscribeFiles = session.onFileEvent((event) => this.onLocalFile(event));
  }

  start(): void {
    this.reconcileStartup();
    this.client.start();
  }

  async stop(): Promise<void> {
    this.unsubscribeFiles();
    await this.client.stop();
    await this.fsOps;
    clearTimeout(this.metaTimer);
    clearTimeout(this.stateTimer);
    this.saveMetaNow();
    this.saveStatesNow();
    this.meta.destroy();
    for (const doc of this.loose.values()) doc.destroy();
    this.loose.clear();
  }

  private makeHost(): SyncHost {
    return {
      openDoc: (docId) => {
        if (docId === META_DOC_ID) return Promise.resolve(this.meta);
        const rel = this.session.relForDocId(docId);
        if (rel) return Promise.resolve(this.session.docFor(rel));
        let doc = this.loose.get(docId);
        if (!doc) {
          doc = new Y.Doc();
          this.loose.set(docId, doc);
        }
        return Promise.resolve(doc);
      },
      listDocIds: () => Promise.resolve([META_DOC_ID, ...this.session.allDocIds()]),
      loadState: (docId) => this.states.get(docId),
      saveState: (docId, state) => {
        this.states.set(docId, state);
        this.scheduleStateSave();
      },
    };
  }

  /** 開機對帳:manifest 有而 meta 沒有 → 補進 meta;meta 有而本地沒有 → 物化(補上次中斷的落地) */
  private reconcileStartup(): void {
    this.meta.transact(() => {
      for (const rel of this.session.list().files) {
        const id = this.session.docId(rel);
        if (this.paths.get(id) !== rel) this.paths.set(id, rel);
      }
    }, "local-meta");
    this.applyRemoteMeta([...this.paths.keys()]);
  }

  private onLocalFile(event: VaultFileEvent): void {
    if (event.kind === "add") {
      const id = this.session.docId(event.rel);
      this.setPath(id, event.rel);
    } else if (event.kind === "rename") {
      const id = this.session.peekDocId(event.to) ?? this.session.docId(event.to);
      this.setPath(id, event.to);
    } else {
      const id = this.session.peekDocId(event.rel);
      if (id && this.paths.get(id) === event.rel) {
        this.meta.transact(() => this.paths.delete(id), "local-meta");
        this.client.forget(id);
      }
    }
  }

  /** 比對後才寫,app 內操作與 watcher 回音、遠端落地的回音都在這裡歸零 */
  private setPath(id: string, rel: string): void {
    if (this.paths.get(id) === rel) return;
    this.meta.transact(() => this.paths.set(id, rel), "local-meta");
  }

  private applyRemoteMeta(docIds: string[]): void {
    for (const docId of docIds) {
      if (docId === META_DOC_ID) continue;
      if (!NOTE_DOC_ID.test(docId)) {
        console.error(`忽略非法的遠端 doc id:${docId}`);
        continue;
      }
      this.fsOps = this.fsOps
        .then(async () => {
          // 佇列執行時才讀狀態:連續變更會自然合併成最終落點
          const rel = this.paths.get(docId);
          const localRel = this.session.relForDocId(docId);
          if (rel === undefined) {
            // 遠端刪除
            if (localRel) {
              this.client.forget(docId);
              await this.session.delete(localRel);
            }
            return;
          }
          if (localRel === rel) return;
          if (localRel) {
            const landed = await this.session.renamePlumbing(localRel, rel);
            if (landed !== rel) this.setPath(docId, landed); // 撞路徑退讓,把實際落點寫回 meta
            return;
          }
          // 遠端新筆記:用 loose 池的內容物化;內容還沒到就先落地空檔,更新會流進 host
          const doc = this.loose.get(docId) ?? new Y.Doc();
          this.loose.delete(docId);
          const landed = this.session.adoptRemoteDoc(rel, docId, doc);
          if (landed !== rel) this.setPath(docId, landed);
        })
        .catch((err: unknown) => {
          console.error(`套用遠端路徑變更失敗 ${docId}:`, err);
        });
    }
  }

  private loadMeta(): void {
    try {
      Y.applyUpdate(this.meta, readFileSync(this.metaFile), "load");
    } catch {
      // 首次同步或狀態不在:從 manifest 重建
    }
  }

  private scheduleMetaSave(): void {
    clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => this.saveMetaNow(), SAVE_DEBOUNCE_MS);
  }

  private saveMetaNow(): void {
    try {
      mkdirSync(path.dirname(this.metaFile), { recursive: true });
      writeFileSync(this.metaFile + ".tmp", Y.encodeStateAsUpdate(this.meta));
      renameSync(this.metaFile + ".tmp", this.metaFile);
    } catch (err) {
      console.error("meta 狀態落盤失敗:", err);
    }
  }

  private loadStates(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, PersistedDocState>;
      for (const [docId, s] of Object.entries(raw)) {
        this.states.set(docId, {
          lastSeq: s.lastSeq,
          counter: s.counter,
          syncedSv: s.syncedSv === undefined ? undefined : Uint8Array.from(Buffer.from(s.syncedSv, "base64")),
        });
      }
    } catch {
      // 首次同步:空狀態
    }
  }

  private scheduleStateSave(): void {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.saveStatesNow(), SAVE_DEBOUNCE_MS);
  }

  private saveStatesNow(): void {
    const out: Record<string, PersistedDocState> = {};
    for (const [docId, s] of this.states) {
      out[docId] = {
        lastSeq: s.lastSeq,
        counter: s.counter,
        syncedSv: s.syncedSv === undefined ? undefined : Buffer.from(s.syncedSv).toString("base64"),
      };
    }
    try {
      mkdirSync(path.dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile + ".tmp", JSON.stringify(out));
      renameSync(this.stateFile + ".tmp", this.stateFile);
    } catch (err) {
      console.error("同步狀態落盤失敗:", err);
    }
  }
}
