// The gate window's only way to talk to the app. Nothing else from Node or Electron is
// reachable from the page.
import { contextBridge, ipcRenderer } from "electron";
import type { GateState } from "../main/gate-state.ts";
import { IPC } from "../main/ipc.ts";

contextBridge.exposeInMainWorld("gatecrusher", {
  getState: (): Promise<GateState> => ipcRenderer.invoke(IPC.gateGetState) as Promise<GateState>,
  onState: (listener: (state: GateState) => void): void => {
    ipcRenderer.on(IPC.gateState, (_event, state: GateState) => listener(state));
  },
  submitCode: (code: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.gateSubmitCode, code) as Promise<boolean>,
  openLogs: (): void => ipcRenderer.send(IPC.gateOpenLogs),
  quit: (): void => ipcRenderer.send(IPC.gateQuit),
});
