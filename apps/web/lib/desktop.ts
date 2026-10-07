import { useSyncExternalStore } from "react";

/** What the desktop app's preload (apps/desktop/src/preload/app.ts) puts on `window`. */
export interface DesktopBridge {
  /** Opens downloads/ (or one playlist's folder in it) in Explorer / Finder. */
  openDownloads(folder?: string): Promise<void>;
}

/** The bridge when the page runs inside the desktop app, otherwise `null`. */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  const candidate: unknown = (window as { gatecrusherDesktop?: unknown }).gatecrusherDesktop;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "openDownloads" in candidate &&
    typeof candidate.openDownloads === "function"
  ) {
    return candidate as DesktopBridge;
  }
  return null;
}

const noSubscription = () => () => undefined;

/**
 * The desktop bridge, read after hydration: the server never has one, so the first
 * render matches the server's and desktop-only controls appear right after.
 */
export function useDesktop(): DesktopBridge | null {
  return useSyncExternalStore(noSubscription, desktopBridge, () => null);
}
