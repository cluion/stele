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
  /** 尚未開啟任何 vault 時回傳 null */
  listVault(): Promise<VaultInfo | null>;
  /** 彈系統選資料夾 dialog 換 vault;使用者取消時回傳 null、現狀不動 */
  chooseVault(): Promise<VaultInfo | null>;
  createNote(rel: string): Promise<string>;
  openDoc(rel: string): Promise<Uint8Array>;
  pushUpdate(rel: string, update: Uint8Array): void;
  /** 回傳退訂函式 */
  onDocUpdate(cb: (rel: string, update: Uint8Array) => void): () => void;
  backlinks(rel: string): Promise<BacklinkItem[]>;
  /** 回傳退訂函式 */
  onIndexUpdated(cb: () => void): () => void;
}

const api: SteleApi = {
  listVault: () => ipcRenderer.invoke("vault:list"),
  chooseVault: () => ipcRenderer.invoke("vault:choose"),
  graph: () => ipcRenderer.invoke("vault:graph"),
  createNote: (rel) => ipcRenderer.invoke("vault:create", rel),
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
};

contextBridge.exposeInMainWorld("stele", api);
