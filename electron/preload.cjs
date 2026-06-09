const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("surgicalApi", {
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  displays: {
    list: () => ipcRenderer.invoke("display:list")
  },
  recordings: {
    create: (payload) => ipcRenderer.invoke("recording:create", payload),
    writeChunk: (payload) => ipcRenderer.invoke("recording:write-chunk", payload),
    close: (payload) => ipcRenderer.invoke("recording:close", payload),
    list: () => ipcRenderer.invoke("recording:list"),
    delete: (id) => ipcRenderer.invoke("recording:delete", id),
    reveal: (id) => ipcRenderer.invoke("recording:reveal", id),
    export: (id) => ipcRenderer.invoke("recording:export", id),
    openRoot: () => ipcRenderer.invoke("recording:open-root")
  }
});
