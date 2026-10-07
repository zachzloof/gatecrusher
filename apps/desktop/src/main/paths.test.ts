import path from "node:path";
import { describe, expect, it } from "vitest";
import { executable, resolvePaths } from "./paths.ts";

describe("resolvePaths", () => {
  it("keeps Windows data in the local, never-synced app data folder", () => {
    const paths = resolvePaths({
      resourcesDir: "C:\\Program Files\\Gatecrusher\\resources",
      platform: "win32",
      userDataDir: "C:\\Users\\dj\\AppData\\Roaming\\Gatecrusher",
      localAppDataDir: "C:\\Users\\dj\\AppData\\Local",
      packaged: true,
    });

    expect(paths.root).toBe(path.join("C:\\Users\\dj\\AppData\\Local", "Gatecrusher"));
    expect(paths.downloadsDir).toBe(path.join(paths.root, "data", "downloads"));
    expect(paths.webServer).toBe(
      path.join("C:\\Program Files\\Gatecrusher\\resources", "web", "apps", "web", "server.js"),
    );
  });

  it("uses Application Support on macOS, and a separate folder when run from the repo", () => {
    const inputs = {
      resourcesDir: "/repo/apps/desktop/stage",
      platform: "darwin" as const,
      userDataDir: "/Users/dj/Library/Application Support/Gatecrusher",
      localAppDataDir: undefined,
    };

    expect(resolvePaths({ ...inputs, packaged: true }).root).toBe(inputs.userDataDir);
    expect(resolvePaths({ ...inputs, packaged: false }).root).toBe(`${inputs.userDataDir}-dev`);
  });

  it("takes a root override from the repo only, never in an installed app", () => {
    const inputs = {
      resourcesDir: "/r",
      platform: "darwin" as const,
      userDataDir: "/u",
      localAppDataDir: undefined,
      rootOverride: "/tmp/smoke",
    };

    expect(resolvePaths({ ...inputs, packaged: false }).root).toBe("/tmp/smoke");
    expect(resolvePaths({ ...inputs, packaged: true }).root).toBe("/u");
  });
});

describe("executable", () => {
  it("adds .exe on Windows only", () => {
    expect(executable("pg_ctl", "win32")).toBe("pg_ctl.exe");
    expect(executable("pg_ctl", "darwin")).toBe("pg_ctl");
  });
});
