const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stele", {
  onDoc: (cb) => ipcRenderer.on("doc", (_e, text) => cb(text)),
  onDoEdit: (cb) => ipcRenderer.on("do-edit", (_e, payload) => cb(payload)),
  edit: (payload) => ipcRenderer.send("edit", payload),
  read: () => ipcRenderer.invoke("read"),
});
