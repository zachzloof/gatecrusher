// The desktop app's own small settings file. Holds the private database's password, so
// it lives in the app's local data folder and is never logged.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const storeSchema = z.object({
  version: z.literal(1),
  /** Password of the app's private Postgres, made on first start. */
  dbPassword: z.string().regex(/^[0-9a-f]{64}$/),
  /** Hash of the access code this machine entered last. */
  acceptedCodeHash: z.string().nullable(),
  /** The latest time the app has seen on this machine (see access.ts). */
  lastSeenAt: z.iso.datetime().nullable(),
});
export type DesktopStore = z.infer<typeof storeSchema>;

export const STORE_FILE = "desktop.json";

function fresh(): DesktopStore {
  return {
    version: 1,
    dbPassword: randomBytes(32).toString("hex"),
    acceptedCodeHash: null,
    lastSeenAt: null,
  };
}

/**
 * Reads the settings, or makes them on first start. An unreadable file is replaced by
 * fresh settings only when there is no database yet: otherwise its password would be
 * lost, so the error is reported instead.
 */
export async function loadStore(
  directory: string,
  options: { databaseExists: boolean },
): Promise<DesktopStore> {
  const file = path.join(directory, STORE_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (options.databaseExists) {
      throw new Error(`${STORE_FILE} is missing but a database exists; its password is gone`, {
        cause: error,
      });
    }
    const created = fresh();
    await saveStore(directory, created);
    return created;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Reported below like any other damage; the parser's message would add nothing.
    json = undefined;
  }
  const parsed = storeSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${STORE_FILE} is not valid`);
  return parsed.data;
}

/** Written to a temporary file first, so a crash never leaves half a file. */
export async function saveStore(directory: string, store: DesktopStore): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, STORE_FILE);
  const partial = `${file}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify(storeSchema.parse(store), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(partial, file);
}
