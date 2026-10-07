import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isNewer, prepareYtDlp, VERSION_FILE } from "./yt-dlp.ts";

describe("isNewer", () => {
  it.each([
    ["2026.10.05", "2026.09.30", true],
    ["2026.09.30", "2026.10.05", false],
    ["2026.09.30", "2026.09.30", false],
    ["2026.09.30", null, true],
    [null, "2026.09.30", false],
    [null, null, false],
  ])("shipped %s over installed %s: %s", (shipped, installed, expected) => {
    expect(isNewer(shipped, installed)).toBe(expected);
  });
});

describe("prepareYtDlp", () => {
  let root: string;
  let shippedBinDir: string;
  let toolsDir: string;

  async function ship(version: string, content: string): Promise<void> {
    await writeFile(path.join(shippedBinDir, "yt-dlp.exe"), content);
    await writeFile(path.join(shippedBinDir, VERSION_FILE), `${version}\n`);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "gatecrusher-ytdlp-"));
    shippedBinDir = path.join(root, "resources");
    toolsDir = path.join(root, "tools");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(shippedBinDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("copies the shipped yt-dlp on first start, then leaves the copy to update itself", async () => {
    await ship("2026.09.30", "shipped");
    const target = await prepareYtDlp({ shippedBinDir, toolsDir, platform: "win32" });
    expect(target).toBe(path.join(toolsDir, "yt-dlp.exe"));
    expect(await readFile(target, "utf8")).toBe("shipped");

    await writeFile(target, "self-updated");
    await prepareYtDlp({ shippedBinDir, toolsDir, platform: "win32" });
    expect(await readFile(target, "utf8")).toBe("self-updated");
  });

  it("replaces the copy when a newer app ships a newer yt-dlp", async () => {
    await ship("2026.09.30", "old");
    await prepareYtDlp({ shippedBinDir, toolsDir, platform: "win32" });

    await ship("2026.11.20", "new");
    const target = await prepareYtDlp({ shippedBinDir, toolsDir, platform: "win32" });

    expect(await readFile(target, "utf8")).toBe("new");
  });
});
