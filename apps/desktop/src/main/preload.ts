import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

export interface BacklinkItem {
  file: string;
  line: string;
}

export interface SteleApi {
  listVault(): Promise<{ vault: string; files: string[] }>;
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
