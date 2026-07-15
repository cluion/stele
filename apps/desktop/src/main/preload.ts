import { contextBridge, ipcRenderer } from "electron";

export interface SteleApi {
  listVault(): Promise<{ vault: string; files: string[] }>;
  openDoc(rel: string): Promise<Uint8Array>;
  pushUpdate(rel: string, update: Uint8Array): void;
  onDocUpdate(cb: (rel: string, update: Uint8Array) => void): void;
}

const api: SteleApi = {
  listVault: () => ipcRenderer.invoke("vault:list"),
  openDoc: (rel) => ipcRenderer.invoke("doc:open", rel),
  pushUpdate: (rel, update) => ipcRenderer.send("doc:push", rel, update),
  onDocUpdate: (cb) => ipcRenderer.on("doc:update", (_e, rel: string, update: Uint8Array) => cb(rel, update)),
};

contextBridge.exposeInMainWorld("stele", api);
