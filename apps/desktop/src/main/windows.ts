import { BrowserWindow, shell } from "electron";
import type { GateState } from "./gate-state.ts";
import { IPC } from "./ipc.ts";

const BACKGROUND = "#0b0c0e";

/** Only web links leave the app, and they open in the user's own browser. */
function openOutside(target: string): void {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    // Not a URL: nothing to open.
    return;
  }
  if (url.protocol === "https:" || url.protocol === "http:") void shell.openExternal(url.href);
}

const secure = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
} as const;

export interface GateWindow {
  window: BrowserWindow;
  show(state: GateState): void;
  current(): GateState;
}

export function createGateWindow(options: {
  html: string;
  preload: string;
  initial: GateState;
}): GateWindow {
  let state = options.initial;
  const window = new BrowserWindow({
    width: 460,
    height: 520,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: BACKGROUND,
    title: "Gatecrusher",
    autoHideMenuBar: true,
    webPreferences: { ...secure, preload: options.preload },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  void window.loadFile(options.html);

  return {
    window,
    current: () => state,
    show: (next) => {
      state = next;
      if (!window.isDestroyed()) window.webContents.send(IPC.gateState, next);
    },
  };
}

/** The app itself: the local web server's pages, nothing else. */
export function createMainWindow(options: { url: string; preload: string }): BrowserWindow {
  const origin = new URL(options.url).origin;
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND,
    title: "Gatecrusher",
    webPreferences: { ...secure, preload: options.preload },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url) && new URL(url).origin === origin) void window.loadURL(url);
    else openOutside(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (URL.canParse(url) && new URL(url).origin === origin) return;
    event.preventDefault();
    openOutside(url);
  });

  void window.loadURL(options.url);
  return window;
}
