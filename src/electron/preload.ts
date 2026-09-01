import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("valeLoot", {
  onAlert(listener: (name: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, name: unknown) => {
      if (typeof name === "string") listener(name);
    };
    ipcRenderer.on("valeLoot:play-sound", handler);
    return () => { ipcRenderer.removeListener("valeLoot:play-sound", handler); };
  },
});
