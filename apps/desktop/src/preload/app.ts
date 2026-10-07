// What the web app can ask of the desktop app. Its presence is also how the web app
// knows it is running inside the desktop app.
import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../main/ipc.ts";

contextBridge.exposeInMainWorld("gatecrusherDesktop", {
  /** Opens downloads/ (or one playlist's folder in it) in Explorer / Finder. */
  openDownloads: (folder?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.openDownloads, folder) as Promise<void>,
});
