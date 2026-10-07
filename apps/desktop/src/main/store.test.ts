import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadStore, saveStore, STORE_FILE } from "./store.ts";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gatecrusher-desktop-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("desktop store", () => {
  it("is made on first start with a random database password", async () => {
    const first = await loadStore(directory, { databaseExists: false });

    expect(first).toMatchObject({ version: 1, acceptedCodeHash: null, lastSeenAt: null });
    expect(first.dbPassword).toMatch(/^[0-9a-f]{64}$/);
    expect(await loadStore(directory, { databaseExists: true })).toEqual(first);
  });

  it("keeps what is saved", async () => {
    const store = await loadStore(directory, { databaseExists: false });
    const updated = {
      ...store,
      acceptedCodeHash: "ab".repeat(32),
      lastSeenAt: "2026-10-07T12:00:00.000Z",
    };

    await saveStore(directory, updated);

    expect(await loadStore(directory, { databaseExists: true })).toEqual(updated);
  });

  it("refuses to invent a new password for an existing database", async () => {
    await expect(loadStore(directory, { databaseExists: true })).rejects.toThrow(
      /password is gone/,
    );
  });

  it("refuses a damaged file instead of overwriting it", async () => {
    await writeFile(path.join(directory, STORE_FILE), JSON.stringify({ version: 1 }));

    await expect(loadStore(directory, { databaseExists: true })).rejects.toThrow(/not valid/);
    expect(await readFile(path.join(directory, STORE_FILE), "utf8")).toBe('{"version":1}');
  });
});
