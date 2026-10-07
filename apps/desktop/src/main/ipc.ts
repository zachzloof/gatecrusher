/** IPC channel names, shared by the main process and the preloads (which stay tiny). */
export const IPC = {
  gateGetState: "gate:get-state",
  gateState: "gate:state",
  gateSubmitCode: "gate:submit-code",
  gateOpenLogs: "gate:open-logs",
  gateQuit: "gate:quit",
  openDownloads: "app:open-downloads",
} as const;
