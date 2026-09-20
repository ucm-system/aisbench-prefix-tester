const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sidecarBridge", {
  getInfo: () => ipcRenderer.invoke("sidecar-info"),
  restart: () => ipcRenderer.invoke("sidecar-restart"),
  onExited: (cb) => ipcRenderer.on("sidecar-exited", (_e, payload) => cb(payload)),
});
