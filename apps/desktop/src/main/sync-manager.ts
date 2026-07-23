import * as Y from "yjs";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import {
  SyncClient,
  spaceOf,
  spaceMembersOf,
  DOC_SPACES_MAP,
  type AwarenessState,
  type Cipher,
  type ShareInfo,
  type SharePermission,
  type SocketLike,
  type SpaceKeySource,
  type SyncIdentity,
  type SyncDocState,
  type SyncHost,
  type SyncStatus,
} from "@stele/sync";
import type { VaultSession, VaultFileEvent } from "./vault-session.ts";
import { VaultMeta, setPath } from "./vault-meta.ts";
import { colorFor } from "./presence-color.ts";
import type { SpaceSyncHooks } from "./spaces-service.ts";
import type { CommentDocSource, CommentSyncHooks } from "./comment-store.ts";

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
  /** 顯示在協作者游標旁的名字;未設時由 deviceId 衍生 */
  displayName?: string;
}

/** 一則分享連結(供 UI 呈現與撤銷);rel 由 docId 反查,遠端未物化的 doc 可能為 undefined */
export interface ShareEntry extends ShareInfo {
  rel: string | undefined;
}

/** 一位在場協作者(已排除自己) */
export interface Participant {
  clientId: number;
  deviceId: string;
  name: string;
  color: string;
  state: AwarenessState;
}

/** 由 ws(s) 同步網址推導檢視器的 http(s) 基底;分享頁與 WS 同一台伺服器同一埠 */
function httpBaseFrom(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const scheme = u.protocol === "wss:" ? "https:" : "http:";
    return `${scheme}//${u.host}`;
  } catch {
    return "";
  }
}

interface PersistedDocState {
  lastSeq: number;
  counter: number;
  syncedSv?: string;
}

const SAVE_DEBOUNCE_MS = 200;

export class SyncManager implements SpaceSyncHooks, CommentSyncHooks {
  /** meta doc 本體;生老病死由 VaultMeta 管(擁有者是 vault 而非同步),同步層只是它的訂閱者 */
  private get meta(): Y.Doc {
    return this.metaStore.doc;
  }
  private readonly paths: Y.Map<string>;
  /** 留言登記表:筆記 docId → 伴生留言 docId,隨 meta 同步,讓留言 doc 的存在跨裝置傳播 */
  /** 伴生留言 doc 的來源(由 main 注入);同步層只負責把它們推上去 */
  private readonly comments: CommentDocSource | undefined;
  private readonly loose = new Map<string, Y.Doc>();
  private readonly states = new Map<string, SyncDocState>();
  private readonly client: SyncClient;
  private readonly unsubscribeFiles: () => void;
  private readonly stateFile: string;
  private stateTimer: NodeJS.Timeout | undefined;
  private onPresence: ((rel: string, participants: Participant[]) => void) | undefined;
  /** 檔案系統操作依序執行,遠端 meta 變更不互相踩腳 */
  private fsOps: Promise<void> = Promise.resolve();
  status: SyncStatus = "offline";
  private readonly self: { deviceId: string; name: string; color: string };
  private exportDocKey: ((docId: string) => Promise<Uint8Array>) | undefined;
  private readonly shareBase: string;
  /** 空間金鑰來源(提供時啟用「空間=帶金鑰單元」路由;預設空間走 master 相容路徑) */
  private readonly spaces: SpaceKeySource | undefined;
  /** 筆記歸屬 Y.Map(docId → spaceId),在 meta doc 上;遠端變更觸發 repull 以新金鑰重解 */
  private readonly docSpaces: Y.Map<string>;
  /** 移動當下離線而未能重推快照的筆記;上線後補推,避免舊金鑰增量卡住其他裝置 */
  private readonly pendingRekey = new Set<string>();
  /** 目前開著的筆記:切換時把在場宣告從舊 doc 移到新 doc */
  private activeRel: string | undefined;

  constructor(
    private readonly session: VaultSession,
    settings: SyncSettings,
    /** meta doc 由 vault 生命週期擁有並注入;同步層只訂閱與推送,絕不銷毀它 */
    private readonly metaStore: VaultMeta,
    private readonly onStatus?: (status: SyncStatus) => void,
    tuning?: {
      pushDebounceMs?: number;
      snapshotThreshold?: number;
      cipher?: Cipher;
      onPresence?: (rel: string, participants: Participant[]) => void;
      /** 匯出某 doc 的原始金鑰,供分享連結放進 URL fragment;未提供則無法建立分享 */
      exportDocKey?: (docId: string) => Promise<Uint8Array>;
      /** 伴生留言 doc 來源:提供時一併納入同步 */
      comments?: CommentDocSource;
      /** 空間金鑰來源:提供時啟用空間路由(每篇筆記以其所屬空間的金鑰加解密);取代 cipher/exportDocKey */
      spaces?: SpaceKeySource;
      /** 成員身分:提供時走帶身分認證(challenge-response);未提供則走 legacy token-only auth */
      identity?: SyncIdentity;
      /** vault 金鑰紀元(2c-2,team vault 由 bootstrap 取得;個人 vault 省略 = 0) */
      epoch?: number;
      /** 金鑰已輪換:推送已暫停,呼叫端應重跑 bootstrap 取新 root 後呼叫 rotateRoot 收斂 */
      onKeyRotated?: (epoch: number) => void;
      /** 輪換 repull 撞到尚未重加密的舊快照時的重試間隔(測試調短) */
      repullRetryMs?: number;
    },
  ) {
    this.self = {
      deviceId: settings.deviceId,
      name: settings.displayName ?? `訪客-${settings.deviceId.slice(0, 4)}`,
      color: colorFor(settings.deviceId),
    };
    this.onPresence = tuning?.onPresence;
    this.spaces = tuning?.spaces;
    this.shareBase = httpBaseFrom(settings.url);
    this.stateFile = path.join(session.root, ".stele", "sync-state.json");
    this.paths = this.meta.getMap("paths");
    this.comments = tuning?.comments;
    this.docSpaces = this.meta.getMap(DOC_SPACES_MAP);
    // 空間路由:每篇筆記以其所屬空間的金鑰加解密;meta/留言/未指派筆記歸屬皆為預設空間 → master 金鑰(零遷移)
    const routingCipher: Cipher | undefined = this.spaces && {
      encrypt: (docId, plain) => this.spaces!.cipher(spaceOf(this.meta, docId)).then((c) => c.encrypt(docId, plain)),
      decrypt: (docId, data) => this.spaces!.cipher(spaceOf(this.meta, docId)).then((c) => c.decrypt(docId, data)),
    };
    this.exportDocKey = this.spaces
      ? (docId) => this.spaces!.cipher(spaceOf(this.meta, docId)).then((c) => c.exportDocKey(docId))
      : tuning?.exportDocKey;
    this.loadStates();

    this.paths.observe((event, tx) => {
      if (tx.origin === "sync") this.applyRemoteMeta(Array.from(event.keysChanged as Set<string>));
    });
    // 遠端得知某筆記換了空間 → 該 docId 的伺服器 blob 已改用新空間金鑰,強制 repull 以新金鑰重解;
    // 移進了我無金鑰的受限空間 → 卸下同步(拿密文也解不開,本地檔案停在最後可讀狀態)
    this.docSpaces.observe((event, tx) => {
      if (tx.origin !== "sync") return;
      for (const docId of event.keysChanged as Set<string>) {
        if (this.canDecrypt(docId)) this.client.repull(docId);
        else this.client.forget(docId);
      }
    });

    this.client = new SyncClient({
      url: settings.url,
      token: settings.token,
      vaultId: settings.vaultId,
      deviceId: settings.deviceId,
      host: this.makeHost(),
      identity: tuning?.identity,
      epoch: tuning?.epoch,
      onKeyRotated: tuning?.onKeyRotated,
      repullRetryMs: tuning?.repullRetryMs,
      createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      onStatus: (status) => {
        const wasOffline = this.status !== "online";
        this.status = status;
        if (status === "online" && wasOffline) this.flushPendingRekey();
        this.onStatus?.(status);
      },
      onAwareness: (docId, states) => this.emitPresence(docId, states),
      pushDebounceMs: tuning?.pushDebounceMs,
      snapshotThreshold: tuning?.snapshotThreshold,
      cipher: routingCipher ?? tuning?.cipher,
    });
    this.unsubscribeFiles = session.onFileEvent((event) => this.onLocalFile(event));
  }

  start(): void {
    this.reconcileStartup();
    this.client.start();
  }

  /** 使用者切換到某篇筆記(或關閉):在該 doc 上宣告在場,舊 doc 撤除 */
  setActiveNote(rel: string | undefined): void {
    if (rel === this.activeRel) return;
    if (this.activeRel !== undefined) {
      const prevId = this.session.peekDocId(this.activeRel);
      if (prevId) this.client.setLocalAwareness(prevId, null);
    }
    this.activeRel = rel;
    if (rel !== undefined) {
      const id = this.session.peekDocId(rel) ?? this.session.docId(rel);
      this.client.setLocalAwareness(id, { deviceId: this.self.deviceId, name: this.self.name, color: this.self.color });
    }
  }

  /** 更新本地游標/選取(疊加在在場狀態上);唯有 activeRel 相符才送 */
  setCursor(rel: string, cursor: AwarenessState | null): void {
    if (rel !== this.activeRel) return;
    const id = this.session.peekDocId(rel);
    if (!id) return;
    this.client.setLocalAwareness(id, {
      deviceId: this.self.deviceId,
      name: this.self.name,
      color: this.self.color,
      ...(cursor ?? {}),
    });
  }

  /** 為某篇筆記建立分享連結:金鑰放進 URL fragment(不進伺服器),回傳完整連結 */
  async createShareLink(rel: string, permission: SharePermission): Promise<{ shareId: string; url: string; permission: SharePermission }> {
    if (!this.exportDocKey) throw new Error("此 vault 未啟用 E2EE,無法建立分享");
    if (!this.shareBase) throw new Error("同步網址無效,無法組出分享連結");
    const docId = this.session.peekDocId(rel) ?? this.session.docId(rel);
    const shareId = await this.client.createShare(docId, permission);
    const key = await this.exportDocKey(docId);
    const url = `${this.shareBase}/s/${shareId}#k=${Buffer.from(key).toString("base64url")}`;
    return { shareId, url, permission };
  }

  /** 列出本 vault 全部分享,附上可讀的相對路徑 */
  async listShares(): Promise<ShareEntry[]> {
    const shares = await this.client.listShares();
    return shares.map((s) => ({ ...s, rel: this.session.relForDocId(s.docId) }));
  }

  async revokeShare(shareId: string): Promise<ShareEntry[]> {
    const shares = await this.client.revokeShare(shareId);
    return shares.map((s) => ({ ...s, rel: this.session.relForDocId(s.docId) }));
  }

  // ── 空間的同步副作用(SpaceSyncHooks);空間本身的 CRUD 在 SpacesService,不需要同步 ──

  /**
   * 筆記移動空間後,以新空間金鑰重推快照、截斷舊金鑰增量,使其他裝置能以新空間金鑰解出。
   * 離線或未拉齊而無法重推時,登記到 pendingRekey,上線後補推。
   */
  async rekeyAfterMove(docId: string): Promise<void> {
    const done = await this.client.rekey(docId);
    if (!done) this.pendingRekey.add(docId);
  }

  /** 新生的 doc(跨空間複製的副本、留言伴生 doc)納入同步 */
  trackNewDoc(docId: string): void {
    this.client.track(docId);
  }

  /** 交出 loose 池中的 doc:伴生 doc materialize 時要沿用同一物件,client runtime 可能已指向它 */
  adoptLoose(docId: string): Y.Doc | undefined {
    const doc = this.loose.get(docId);
    if (doc) this.loose.delete(docId);
    return doc;
  }

  // ── 金鑰輪換(2c-2)與空間存取(per-space 成員子集) ──

  /**
   * 我能否解開某 doc:未受限空間(含個人 vault)恆可;受限空間看是否持有其獨立金鑰。
   * 判定用 meta 的空間名單 + 金鑰來源的實際持有——名單說我在但金鑰未到(輪換未達)一樣不可,
   * 絕不拿 root fallback 去解受限空間的密文(解不開,徒留噪音與空檔)。
   */
  private canDecrypt(docId: string): boolean {
    if (!this.spaces?.hasSpaceKey) return true;
    const spaceId = spaceOf(this.meta, docId);
    if (spaceMembersOf(this.meta, spaceId) === undefined) return true;
    return this.spaces.hasSpaceKey(spaceId);
  }

  /**
   * 換 root 收斂:原地 rotate 金鑰來源(routingCipher 閉包自動走新金鑰)、前移 epoch 恢復推送。
   * 成員端 repull=true 全量重拉;owner 端(自己重加密)傳 false,隨後呼叫 rekeyAll。
   * spaceKeys = 這一紀元我拿到的受限空間金鑰(整組換到位);新獲授權的空間筆記隨後補物化。
   */
  async rotateRoot(newRoot: Uint8Array, epoch: number, repull = true, spaceKeys?: ReadonlyMap<string, Uint8Array>): Promise<void> {
    if (!this.spaces?.rotate) throw new Error("此 vault 的金鑰來源不支援輪換");
    this.spaces.rotate(newRoot, spaceKeys);
    await this.client.applyRotation(epoch, repull);
    // 先前因無金鑰而跳過物化的筆記,這一紀元可能獲授權了:重套 meta 補落地
    this.applyRemoteMeta([...this.paths.keys()]);
  }

  /** 是否已拉齊伺服器上所有 doc(owner 輪換前置檢查;未拉齊必須中止輪換) */
  allCaughtUp(): boolean {
    return this.client.allCaughtUp();
  }

  /** owner 輪換後在柵欄下對每個 doc 以新金鑰重推快照(冪等);回傳是否全部完成 */
  rekeyAll(): Promise<boolean> {
    return this.client.rekeyAll();
  }

  /** 上線後補推移動當下未能重推的快照,直到成功才移出待辦 */
  private flushPendingRekey(): void {
    for (const docId of [...this.pendingRekey]) {
      void this.client.rekey(docId).then((done) => {
        if (done) this.pendingRekey.delete(docId);
      });
    }
  }

  private emitPresence(docId: string, states: Map<number, AwarenessState>): void {
    const rel = docId === META_DOC_ID ? undefined : this.session.relForDocId(docId);
    if (rel === undefined || !this.onPresence) return;
    const participants: Participant[] = [];
    for (const [clientId, state] of states) {
      if (state["deviceId"] === this.self.deviceId) continue; // 排除自己
      participants.push({
        clientId,
        deviceId: typeof state["deviceId"] === "string" ? state["deviceId"] : "",
        name: typeof state["name"] === "string" ? state["name"] : "訪客",
        color: typeof state["color"] === "string" ? state["color"] : "#888",
        state,
      });
    }
    this.onPresence(rel, participants);
  }

  async stop(): Promise<void> {
    this.unsubscribeFiles();
    await this.client.stop();
    await this.fsOps;
    clearTimeout(this.stateTimer);
    this.saveStatesNow();
    // 不動 metaStore 與 comments:兩者屬於 vault 生命週期,由 main 在換 vault/退出時收
    for (const doc of this.loose.values()) doc.destroy();
    this.loose.clear();
  }

  /** 目前使用者身分,供 renderer 標記留言作者 */
  identity(): { deviceId: string; name: string; color: string } {
    return { ...this.self };
  }

  private makeHost(): SyncHost {
    return {
      openDoc: (docId) => {
        if (docId === META_DOC_ID) return Promise.resolve(this.meta);
        // 受限空間且我無金鑰:整個 doc 不承接——不 pull、不解密、不物化(含伴生留言 doc)
        if (!this.canDecrypt(docId)) return Promise.resolve(undefined);
        const comment = this.comments?.get(docId);
        if (comment) return Promise.resolve(comment);
        const rel = this.session.relForDocId(docId);
        if (rel) return Promise.resolve(this.session.docFor(rel));
        // 未知 docId 必須是合法 UUID 才承接(可能是 meta 還沒到的遠端新 doc)
        // 否則任何有 token 的連線可用垃圾 docId 灌爆 loose 池與 awareness 計時器
        if (!NOTE_DOC_ID.test(docId)) return Promise.resolve(undefined);
        let doc = this.loose.get(docId);
        if (!doc) {
          doc = new Y.Doc();
          this.loose.set(docId, doc);
        }
        return Promise.resolve(doc);
      },
      listDocIds: () => Promise.resolve([META_DOC_ID, ...this.session.allDocIds(), ...(this.comments?.ids() ?? [])]),
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

  private setPath(id: string, rel: string): void {
    setPath(this.metaStore, id, rel);
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
          // 受限空間且我無金鑰:不物化、不改名(內容解不開,落地只會是空檔);獲授權後 rotateRoot 補跑
          if (!this.canDecrypt(docId)) return;
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
