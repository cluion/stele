import * as Y from "yjs";
import WebSocket from "ws";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  SyncClient,
  readSpaces,
  spaceOf,
  readAudit,
  createSpace as createSpaceModel,
  renameSpace as renameSpaceModel,
  moveNote as moveNoteModel,
  recordCopy as recordCopyModel,
  SPACES_MAP,
  DOC_SPACES_MAP,
  type AwarenessState,
  type Cipher,
  type ShareInfo,
  type SharePermission,
  type SocketLike,
  type Space,
  type SpaceAuditEvent,
  type SpaceKeySource,
  type SyncDocState,
  type SyncHost,
  type SyncStatus,
} from "@stele/sync";
import type { VaultSession, VaultFileEvent } from "./vault-session.ts";
import { VaultMeta } from "./vault-meta.ts";

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

/** 從 deviceId 穩定衍生一個好看的色相,同一裝置每次同色 */
const PRESENCE_COLORS = ["#0e7b93", "#d99a3d", "#b5485d", "#5b8c5a", "#7d5ba6", "#c56b2d", "#2c7da0"];
function colorFor(deviceId: string): string {
  let h = 0;
  for (const ch of deviceId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

/** 由筆記 docId 決定性衍生留言伴生 docId(UUID 形狀);兩裝置各自算出同一個,免對照即可避免分裂 */
function commentDocIdFor(noteDocId: string): string {
  const h = createHash("sha256").update(`stele-comments:${noteDocId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** 複製筆記的目標路徑:「a/b.md」→「a/b (副本).md」(進一步撞名由 VaultSession freeVariant 退讓) */
function copyPathFor(rel: string): string {
  const dir = path.dirname(rel);
  const name = `${path.basename(rel).replace(/\.md$/, "")} (副本).md`;
  return dir === "." ? name : `${dir}/${name}`;
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

export class SyncManager {
  private readonly metaStore: VaultMeta;
  /** meta doc 本體;生老病死由 VaultMeta 管,同步層只是它的訂閱者 */
  private get meta(): Y.Doc {
    return this.metaStore.doc;
  }
  private readonly paths: Y.Map<string>;
  /** 留言登記表:筆記 docId → 伴生留言 docId,隨 meta 同步,讓留言 doc 的存在跨裝置傳播 */
  private readonly comments: Y.Map<string>;
  /** 伴生留言 doc(不鏡像磁碟,存 .stele/comments/<id>.ybin) */
  private readonly commentDocs = new Map<string, Y.Doc>();
  private readonly commentIds = new Set<string>();
  private readonly commentSaveTimers = new Map<string, NodeJS.Timeout>();
  private readonly commentsDir: string;
  private onCommentUpdate: ((noteDocId: string, update: Uint8Array) => void) | undefined;
  private readonly loose = new Map<string, Y.Doc>();
  private readonly states = new Map<string, SyncDocState>();
  private readonly client: SyncClient;
  private readonly unsubscribeFiles: () => void;
  private readonly stateFile: string;
  private stateTimer: NodeJS.Timeout | undefined;
  private onPresence: ((rel: string, participants: Participant[]) => void) | undefined;
  private onSpacesChange: (() => void) | undefined;
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
    private readonly onStatus?: (status: SyncStatus) => void,
    tuning?: {
      pushDebounceMs?: number;
      snapshotThreshold?: number;
      cipher?: Cipher;
      onPresence?: (rel: string, participants: Participant[]) => void;
      /** 匯出某 doc 的原始金鑰,供分享連結放進 URL fragment;未提供則無法建立分享 */
      exportDocKey?: (docId: string) => Promise<Uint8Array>;
      /** 伴生留言 doc 有遠端更新時通知(noteDocId + Y update),供 main 廣播給 renderer */
      onCommentUpdate?: (noteDocId: string, update: Uint8Array) => void;
      /** 空間金鑰來源:提供時啟用空間路由(每篇筆記以其所屬空間的金鑰加解密);取代 cipher/exportDocKey */
      spaces?: SpaceKeySource;
      /** 空間登記或筆記歸屬有變(本地或遠端),供 main 通知 renderer 刷新側欄 */
      onSpacesChange?: () => void;
    },
  ) {
    this.self = {
      deviceId: settings.deviceId,
      name: settings.displayName ?? `訪客-${settings.deviceId.slice(0, 4)}`,
      color: colorFor(settings.deviceId),
    };
    this.onPresence = tuning?.onPresence;
    this.onSpacesChange = tuning?.onSpacesChange;
    this.spaces = tuning?.spaces;
    this.shareBase = httpBaseFrom(settings.url);
    this.metaStore = new VaultMeta(session.root);
    this.stateFile = path.join(session.root, ".stele", "sync-state.json");
    this.commentsDir = path.join(session.root, ".stele", "comments");
    this.paths = this.meta.getMap("paths");
    this.comments = this.meta.getMap("comments");
    this.docSpaces = this.meta.getMap(DOC_SPACES_MAP);
    this.onCommentUpdate = tuning?.onCommentUpdate;
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
    this.comments.observe((event, tx) => {
      if (tx.origin === "sync") this.onRemoteComments(Array.from(event.keysChanged as Set<string>));
    });
    // 遠端得知某筆記換了空間 → 該 docId 的伺服器 blob 已改用新空間金鑰,強制 repull 以新金鑰重解
    this.docSpaces.observe((event, tx) => {
      if (tx.origin === "sync") for (const docId of event.keysChanged as Set<string>) this.client.repull(docId);
      this.onSpacesChange?.();
    });
    // 空間登記變更(建立/改名/顏色,含巢狀欄位)→ 通知刷新側欄;observeDeep 才抓得到改名
    this.meta.getMap(SPACES_MAP).observeDeep(() => this.onSpacesChange?.());

    this.client = new SyncClient({
      url: settings.url,
      token: settings.token,
      vaultId: settings.vaultId,
      deviceId: settings.deviceId,
      host: this.makeHost(),
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
    // client 就緒後,把既有留言 doc 讀進記憶體,才會進 listDocIds、連線後同步
    for (const [noteDocId, commentDocId] of this.comments.entries()) {
      if (NOTE_DOC_ID.test(commentDocId)) this.commentDocFor(commentDocId, noteDocId);
    }
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

  // ── 空間(vault → 空間 → 筆記三層的中繼資料 + 金鑰路由)──

  /** 全部空間(含預設空間,永遠在最前) */
  listSpaces(): Space[] {
    return readSpaces(this.meta);
  }

  /** 空間總覽:全部空間 + 每篇筆記歸屬(rel → spaceId,僅非預設空間) */
  spacesOverview(): { spaces: Space[]; assignments: Record<string, string> } {
    const assignments: Record<string, string> = {};
    for (const [docId, spaceId] of this.docSpaces.entries()) {
      const rel = this.session.relForDocId(docId);
      if (rel !== undefined) assignments[rel] = spaceId;
    }
    return { spaces: readSpaces(this.meta), assignments };
  }

  /** 建立新空間,回傳新 spaceId(id 由此處生成 UUID) */
  createSpace(name: string, color?: string): string {
    const id = randomUUID();
    this.meta.transact(() => createSpaceModel(this.meta, { id, name, color, at: Date.now() }), "local-meta");
    return id;
  }

  renameSpace(spaceId: string, name: string): void {
    this.meta.transact(() => renameSpaceModel(this.meta, spaceId, name, Date.now()), "local-meta");
  }

  /** 某筆記所屬空間 id(未指派 → 預設空間) */
  spaceOfNote(rel: string): string {
    const id = this.session.peekDocId(rel) ?? this.session.docId(rel);
    return spaceOf(this.meta, id);
  }

  /**
   * 把筆記移到某空間:改歸屬(路由 cipher 之後對此 docId 改用新空間金鑰),
   * 再以新金鑰重推快照、截斷舊金鑰增量,使其他裝置能以新空間金鑰解出。
   * 離線或未拉齊而無法重推時,登記到 pendingRekey,上線後補推。
   */
  async moveNoteToSpace(rel: string, spaceId: string): Promise<void> {
    const docId = this.session.peekDocId(rel) ?? this.session.docId(rel);
    if (spaceOf(this.meta, docId) === spaceId) return;
    this.meta.transact(() => moveNoteModel(this.meta, docId, spaceId, Date.now()), "local-meta");
    const done = await this.client.rekey(docId);
    if (!done) this.pendingRekey.add(docId);
  }

  /**
   * 複製筆記到某空間:目標空間生一篇全新筆記(新 docId、內容複製),原筆記原封不動。
   * 自出生即以目標空間金鑰加密——先 recordCopy 登記歸屬,再建檔開 host、track 同步,
   * 確保第一次 push 就走目標空間的金鑰。回傳副本的相對路徑。
   */
  copyNoteToSpace(rel: string, spaceId: string): string {
    const fromDocId = this.session.peekDocId(rel) ?? this.session.docId(rel);
    const md = this.session.docFor(rel).getText("md").toString();
    const copy = new Y.Doc();
    copy.getText("md").insert(0, md);
    const newDocId = randomUUID();
    // 先登記歸屬:讓 track 觸發的第一次 push 就以目標空間金鑰加密,免得先用預設金鑰再重推
    this.meta.transact(
      () => recordCopyModel(this.meta, { fromDocId, newDocId, toSpaceId: spaceId, at: Date.now() }),
      "local-meta",
    );
    const landed = this.session.adoptRemoteDoc(copyPathFor(rel), newDocId, copy);
    this.setPath(newDocId, landed);
    this.client.track(newDocId);
    return landed;
  }

  /** 空間變更稽核紀錄(append-only)供 UI 追查 */
  readSpaceAudit(): SpaceAuditEvent[] {
    return readAudit(this.meta);
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
    for (const timer of this.commentSaveTimers.values()) clearTimeout(timer);
    this.commentSaveTimers.clear();
    this.saveStatesNow();
    for (const commentDocId of this.commentDocs.keys()) this.saveCommentNow(commentDocId);
    this.metaStore.stop();
    for (const doc of this.commentDocs.values()) doc.destroy();
    this.commentDocs.clear();
    this.commentIds.clear();
    for (const doc of this.loose.values()) doc.destroy();
    this.loose.clear();
  }

  /** 目前使用者身分,供 renderer 標記留言作者 */
  identity(): { deviceId: string; name: string; color: string } {
    return { ...this.self };
  }

  /** 開啟某筆記的留言 doc(必要時建立),回傳目前狀態快照供 renderer 投影 */
  openCommentDoc(noteRel: string): Uint8Array {
    const noteDocId = this.session.peekDocId(noteRel) ?? this.session.docId(noteRel);
    return Y.encodeStateAsUpdate(this.ensureCommentDoc(noteDocId));
  }

  /** renderer 對留言 doc 的本地變更:origin "renderer" 讓 client 推同步、不回音給自己 */
  pushComment(noteRel: string, update: Uint8Array): void {
    const noteDocId = this.session.peekDocId(noteRel) ?? this.session.docId(noteRel);
    Y.applyUpdate(this.ensureCommentDoc(noteDocId), update, "renderer");
  }

  private ensureCommentDoc(noteDocId: string): Y.Doc {
    // 決定性 id:兩裝置由同一 noteDocId 各自算出同一個 commentDocId,避免併發開啟時分裂
    const commentDocId = commentDocIdFor(noteDocId);
    if (this.comments.get(noteDocId) !== commentDocId) {
      this.meta.transact(() => this.comments.set(noteDocId, commentDocId), "local-meta");
    }
    return this.commentDocFor(commentDocId, noteDocId);
  }

  private commentDocFor(commentDocId: string, noteDocId: string): Y.Doc {
    const cached = this.commentDocs.get(commentDocId);
    if (cached) return cached;
    // 沿用 loose 池同一物件(client runtime 可能已指向它),否則從 .ybin 載入
    let doc = this.loose.get(commentDocId);
    if (doc) this.loose.delete(commentDocId);
    else doc = this.loadCommentDoc(commentDocId);
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.scheduleCommentSave(commentDocId);
      if (origin !== "renderer") this.onCommentUpdate?.(noteDocId, update);
    });
    this.commentDocs.set(commentDocId, doc);
    this.commentIds.add(commentDocId);
    this.client.track(commentDocId);
    return doc;
  }

  /** 遠端 meta 帶來新的留言登記:materialize 伴生 doc 並開始同步 */
  private onRemoteComments(noteDocIds: string[]): void {
    for (const noteDocId of noteDocIds) {
      const commentDocId = this.comments.get(noteDocId);
      if (commentDocId && NOTE_DOC_ID.test(commentDocId) && !this.commentDocs.has(commentDocId)) {
        const update = Y.encodeStateAsUpdate(this.commentDocFor(commentDocId, noteDocId));
        this.onCommentUpdate?.(noteDocId, update); // 讓已開著該筆記的 renderer 立即收到既有留言
      }
    }
  }

  private loadCommentDoc(commentDocId: string): Y.Doc {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, readFileSync(path.join(this.commentsDir, `${commentDocId}.ybin`)), "load");
    } catch {
      // 首次:空 doc
    }
    return doc;
  }

  private scheduleCommentSave(commentDocId: string): void {
    clearTimeout(this.commentSaveTimers.get(commentDocId));
    this.commentSaveTimers.set(
      commentDocId,
      setTimeout(() => this.saveCommentNow(commentDocId), SAVE_DEBOUNCE_MS),
    );
  }

  private saveCommentNow(commentDocId: string): void {
    const doc = this.commentDocs.get(commentDocId);
    if (!doc) return;
    try {
      mkdirSync(this.commentsDir, { recursive: true });
      const file = path.join(this.commentsDir, `${commentDocId}.ybin`);
      writeFileSync(file + ".tmp", Y.encodeStateAsUpdate(doc));
      renameSync(file + ".tmp", file);
    } catch (err) {
      console.error(`留言狀態落盤失敗 ${commentDocId}:`, err);
    }
  }

  private makeHost(): SyncHost {
    return {
      openDoc: (docId) => {
        if (docId === META_DOC_ID) return Promise.resolve(this.meta);
        if (this.commentIds.has(docId)) return Promise.resolve(this.commentDocs.get(docId));
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
      listDocIds: () => Promise.resolve([META_DOC_ID, ...this.session.allDocIds(), ...this.commentIds]),
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
