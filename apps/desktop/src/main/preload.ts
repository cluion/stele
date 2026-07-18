import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface BacklinkItem {
  file: string;
  line: string;
}

export interface VaultInfo {
  vault: string;
  /** vault 的絕對路徑,同名 vault 的唯一識別 */
  root: string;
  files: string[];
}

export interface GraphData {
  nodes: string[];
  edges: Array<[number, number]>;
}

export interface SteleApi {
  graph(): Promise<GraphData>;
  daily(): Promise<string>;
  search(query: string): Promise<BacklinkItem[]>;
  /** 尚未開啟任何 vault 時回傳 null */
  listVault(): Promise<VaultInfo | null>;
  /** 彈系統選資料夾 dialog 換 vault;使用者取消時回傳 null、現狀不動 */
  chooseVault(): Promise<VaultInfo | null>;
  createNote(rel: string): Promise<string>;
  renameNote(oldRel: string, next: string): Promise<string>;
  deleteNote(rel: string): Promise<void>;
  openDoc(rel: string): Promise<Uint8Array>;
  pushUpdate(rel: string, update: Uint8Array): void;
  /** 回傳退訂函式 */
  onDocUpdate(cb: (rel: string, update: Uint8Array) => void): () => void;
  backlinks(rel: string): Promise<BacklinkItem[]>;
  /** 回傳退訂函式 */
  onIndexUpdated(cb: () => void): () => void;
  /** "off" = 未設定同步 */
  syncStatus(): Promise<string>;
  /** 回傳退訂函式 */
  onSyncStatus(cb: (status: string) => void): () => void;
  /** 宣告目前開著的筆記(或 null 關閉),用於協作在場 */
  setActiveNote(rel: string | null): void;
  /** 回報本地游標/選取(疊在在場狀態上),用於他人渲染我的游標 */
  setCursor(rel: string, cursor: Record<string, unknown> | null): void;
  /** 在場協作者變化;回傳退訂函式 */
  onPresence(cb: (rel: string, participants: Participant[]) => void): () => void;
  /** 為某篇筆記建立分享連結(唯讀/可編輯);金鑰在 fragment 不進伺服器 */
  createShare(rel: string, permission: SharePermission): Promise<ShareLink>;
  /** 開啟某筆記的留言 doc:回傳目前狀態快照 + 本地使用者身分;同步未啟用回 null */
  openComments(rel: string): Promise<{ snapshot: Uint8Array; me: CommentIdentity } | null>;
  pushComments(rel: string, update: Uint8Array): void;
  /** 留言 doc 遠端更新(帶所屬筆記 rel);回傳退訂函式 */
  onCommentsUpdate(cb: (rel: string, update: Uint8Array) => void): () => void;
  /** 列出本 vault 全部分享(含已撤銷) */
  listShares(): Promise<ShareEntry[]>;
  revokeShare(shareId: string): Promise<ShareEntry[]>;
  /** 消費一則分享連結,開臨時協作 session;連結無效回 { ok:false } */
  consumeShare(url: string): Promise<{ ok: boolean; error?: string }>;
  /** 取共享 doc 目前狀態(進入共享模式時);無 session 回 null */
  openShared(): Promise<Uint8Array | null>;
  pushShared(update: Uint8Array): void;
  closeShared(): Promise<void>;
  /** 回傳退訂函式 */
  onSharedStatus(cb: (status: string) => void): () => void;
  /** 伺服器回報的分享權限,決定共享編輯器是否唯讀;回傳退訂函式 */
  onSharedPermission(cb: (permission: SharePermission) => void): () => void;
  /** 共享 doc 首次追平;回傳退訂函式 */
  onSharedSynced(cb: () => void): () => void;
  /** 分享失效(撤銷/過期/不存在);回傳退訂函式 */
  onSharedClosed(cb: (code: string) => void): () => void;
  /** 共享 doc 遠端更新;回傳退訂函式 */
  onSharedUpdate(cb: (update: Uint8Array) => void): () => void;
}

export interface CommentIdentity {
  deviceId: string;
  name: string;
  color: string;
}

export type SharePermission = "read" | "write";

export interface ShareLink {
  shareId: string;
  url: string;
  permission: SharePermission;
}

export interface ShareEntry {
  shareId: string;
  docId: string;
  permission: SharePermission;
  revoked: boolean;
  rel: string | undefined;
}

export interface Participant {
  clientId: number;
  deviceId: string;
  name: string;
  color: string;
  state: Record<string, unknown>;
}

const api: SteleApi = {
  listVault: () => ipcRenderer.invoke("vault:list"),
  chooseVault: () => ipcRenderer.invoke("vault:choose"),
  graph: () => ipcRenderer.invoke("vault:graph"),
  daily: () => ipcRenderer.invoke("vault:daily"),
  search: (query) => ipcRenderer.invoke("vault:search", query),
  createNote: (rel) => ipcRenderer.invoke("vault:create", rel),
  renameNote: (oldRel, next) => ipcRenderer.invoke("vault:rename", oldRel, next),
  deleteNote: (rel) => ipcRenderer.invoke("vault:delete", rel),
  openDoc: (rel) => ipcRenderer.invoke("doc:open", rel),
  pushUpdate: (rel, update) => ipcRenderer.send("doc:push", rel, update),
  onDocUpdate: (cb) => {
    const handler = (_e: IpcRendererEvent, rel: string, update: Uint8Array) => cb(rel, update);
    ipcRenderer.on("doc:update", handler);
    return () => ipcRenderer.off("doc:update", handler);
  },
  backlinks: (rel) => ipcRenderer.invoke("vault:backlinks", rel),
  onIndexUpdated: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("index:updated", handler);
    return () => ipcRenderer.off("index:updated", handler);
  },
  syncStatus: () => ipcRenderer.invoke("sync:status"),
  onSyncStatus: (cb) => {
    const handler = (_e: IpcRendererEvent, status: string) => cb(status);
    ipcRenderer.on("sync:status", handler);
    return () => ipcRenderer.off("sync:status", handler);
  },
  setActiveNote: (rel) => ipcRenderer.send("presence:active", rel),
  setCursor: (rel, cursor) => ipcRenderer.send("presence:cursor", rel, cursor),
  onPresence: (cb) => {
    const handler = (_e: IpcRendererEvent, rel: string, participants: Participant[]) => cb(rel, participants);
    ipcRenderer.on("presence:update", handler);
    return () => ipcRenderer.off("presence:update", handler);
  },
  openComments: (rel) => ipcRenderer.invoke("comments:open", rel),
  pushComments: (rel, update) => ipcRenderer.send("comments:push", rel, update),
  onCommentsUpdate: (cb) => {
    const handler = (_e: IpcRendererEvent, rel: string, update: Uint8Array) => cb(rel, update);
    ipcRenderer.on("comments:update", handler);
    return () => ipcRenderer.off("comments:update", handler);
  },
  createShare: (rel, permission) => ipcRenderer.invoke("share:create", rel, permission),
  listShares: () => ipcRenderer.invoke("share:list"),
  revokeShare: (shareId) => ipcRenderer.invoke("share:revoke", shareId),
  consumeShare: (url) => ipcRenderer.invoke("shared:consume", url),
  openShared: () => ipcRenderer.invoke("shared:open"),
  pushShared: (update) => ipcRenderer.send("shared:push", update),
  closeShared: () => ipcRenderer.invoke("shared:close"),
  onSharedStatus: (cb) => {
    const handler = (_e: IpcRendererEvent, status: string) => cb(status);
    ipcRenderer.on("shared:status", handler);
    return () => ipcRenderer.off("shared:status", handler);
  },
  onSharedPermission: (cb) => {
    const handler = (_e: IpcRendererEvent, permission: SharePermission) => cb(permission);
    ipcRenderer.on("shared:permission", handler);
    return () => ipcRenderer.off("shared:permission", handler);
  },
  onSharedSynced: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("shared:synced", handler);
    return () => ipcRenderer.off("shared:synced", handler);
  },
  onSharedClosed: (cb) => {
    const handler = (_e: IpcRendererEvent, code: string) => cb(code);
    ipcRenderer.on("shared:closed", handler);
    return () => ipcRenderer.off("shared:closed", handler);
  },
  onSharedUpdate: (cb) => {
    const handler = (_e: IpcRendererEvent, update: Uint8Array) => cb(update);
    ipcRenderer.on("shared:update", handler);
    return () => ipcRenderer.off("shared:update", handler);
  },
};

contextBridge.exposeInMainWorld("stele", api);
