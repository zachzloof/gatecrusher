import { Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
  openDownloads: () => void;
  openLogs: () => void;
  /** One line about this build, for the Help menu. */
  about: string;
}

/** Edit is there so copy and paste work (pasting the SoundCloud token, on macOS too). */
export function installMenu(actions: MenuActions, platform: NodeJS.Platform): void {
  const isMac = platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Downloads Folder",
          accelerator: "CmdOrCtrl+Shift+D",
          click: actions.openDownloads,
        },
        { label: "Open Log Files", click: actions.openLogs },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: actions.about, enabled: false }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
