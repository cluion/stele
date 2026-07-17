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
  /** 列出本 vault 全部分享(含已撤銷) */
  listShares(): Promise<ShareEntry[]>;
  revokeShare(shareId: string): Promise<ShareEntry[]>;
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
  createShare: (rel, permission) => ipcRenderer.invoke("share:create", rel, permission),
  listShares: () => ipcRenderer.invoke("share:list"),
  revokeShare: (shareId) => ipcRenderer.invoke("share:revoke", shareId),
};

contextBridge.exposeInMainWorld("stele", api);
