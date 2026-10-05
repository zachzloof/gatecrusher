import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createZipStream, uniqueEntryNames, type ZipEntryInput } from "./zip-stream";

const run = promisify(execFile);

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gatecrusher-zip-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

function entry(name: string, body: Buffer): ZipEntryInput {
  return { name, sizeBytes: body.length, open: () => Readable.from([body]) };
}

function collect(stream: Readable): Promise<Buffer> {
  return buffer(stream);
}

/** A minimal reader of what the writer produced, independent of the writer's code. */
function parseCentralDirectory(zip: Buffer) {
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("no end record");
  let entryCount = zip.readUInt16LE(end + 10);
  let directoryOffset = zip.readUInt32LE(end + 16);
  let zip64 = false;
  if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
    zip64 = true;
    const locator = end - 20;
    if (zip.readUInt32LE(locator) !== 0x07064b50) throw new Error("no zip64 locator");
    const record = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(record) !== 0x06064b50) throw new Error("no zip64 end record");
    entryCount = Number(zip.readBigUInt64LE(record + 32));
    directoryOffset = Number(zip.readBigUInt64LE(record + 48));
  }

  const entries: Array<{ name: string; crc: number; size: number; offset: number }> = [];
  let cursor = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central header");
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    let size = zip.readUInt32LE(cursor + 24);
    let offset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (size === 0xffffffff || offset === 0xffffffff) {
      let extra = cursor + 46 + nameLength;
      if (zip.readUInt16LE(extra) !== 0x0001) throw new Error("no zip64 extra");
      extra += 4;
      if (size === 0xffffffff) {
        size = Number(zip.readBigUInt64LE(extra));
        extra += 16;
      }
      if (offset === 0xffffffff) offset = Number(zip.readBigUInt64LE(extra));
    }
    entries.push({ name, crc: zip.readUInt32LE(cursor + 16), size, offset });
    cursor += 46 + nameLength + extraLength;
  }
  return { zip64, entries };
}

/** The bytes of an entry, read through its local header as an extractor would. */
function entryData(zip: Buffer, offset: number, size: number): Buffer {
  if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error("bad local header");
  const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
  return zip.subarray(start, start + size);
}

const SONG_A = Buffer.from("ID3 fake audio A ".repeat(1_000));
const SONG_B = Buffer.from("RIFF fake audio B ".repeat(2_000));

describe("createZipStream", () => {
  it("stores every file as-is, with the right CRC, size and name", async () => {
    const zip = await collect(
      createZipStream([entry("Artist - Song A.mp3", SONG_A), entry("Artist - Sông B.wav", SONG_B)]),
    );

    const { zip64, entries } = parseCentralDirectory(zip);
    expect(zip64).toBe(false);
    expect(entries.map((item) => [item.name, item.size, item.crc])).toEqual([
      ["Artist - Song A.mp3", SONG_A.length, crc32(SONG_A)],
      ["Artist - Sông B.wav", SONG_B.length, crc32(SONG_B)],
    ]);
    expect(entryData(zip, entries[0]?.offset ?? 0, SONG_A.length).equals(SONG_A)).toBe(true);
    expect(entryData(zip, entries[1]?.offset ?? 0, SONG_B.length).equals(SONG_B)).toBe(true);
    // Stored, not compressed: the archive is the files plus headers.
    expect(zip.length).toBeGreaterThan(SONG_A.length + SONG_B.length);
    expect(zip.length).toBeLessThan(SONG_A.length + SONG_B.length + 1_000);
  });

  it("writes an empty archive for no files", async () => {
    const zip = await collect(createZipStream([]));

    expect(parseCentralDirectory(zip).entries).toEqual([]);
    expect(zip.length).toBe(22);
  });

  it("writes zip64 structures when asked, and they resolve to the same entries", async () => {
    const zip = await collect(
      createZipStream([entry("a.mp3", SONG_A), entry("b.wav", SONG_B)], { forceZip64: true }),
    );

    const { zip64, entries } = parseCentralDirectory(zip);
    expect(zip64).toBe(true);
    expect(entries.map((item) => [item.name, item.size])).toEqual([
      ["a.mp3", SONG_A.length],
      ["b.wav", SONG_B.length],
    ]);
    expect(entryData(zip, entries[1]?.offset ?? 0, SONG_B.length).equals(SONG_B)).toBe(true);
  });

  it("streams: a chunk arrives before the last file has been read", async () => {
    let opened = 0;
    const stream = createZipStream([
      { ...entry("a.mp3", SONG_A), open: () => ((opened += 1), Readable.from([SONG_A])) },
      { ...entry("b.wav", SONG_B), open: () => ((opened += 1), Readable.from([SONG_B])) },
    ]);

    const first = await stream[Symbol.asyncIterator]().next();

    expect(first.done).toBe(false);
    expect(opened).toBeLessThan(2);
    stream.destroy();
  });

  it("fails the archive when a file cannot be read", async () => {
    const broken: ZipEntryInput = {
      name: "gone.mp3",
      sizeBytes: 10,
      open: () =>
        new Readable({
          read() {
            this.destroy(new Error("ENOENT: file is gone"));
          },
        }),
    };

    await expect(collect(createZipStream([entry("a.mp3", SONG_A), broken]))).rejects.toThrow(
      /gone/,
    );
  });

  it("is a zip the operating system can extract", async () => {
    const archive = path.join(directory, "playlist.zip");
    const target = path.join(directory, "out");
    await writeFile(
      archive,
      await collect(
        createZipStream([entry("Artist - Song A.mp3", SONG_A), entry("b.wav", SONG_B)]),
      ),
    );

    if (process.platform === "win32") {
      await run("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${target}' -Force`,
      ]);
    } else {
      try {
        await run("unzip", ["-o", "-q", archive, "-d", target]);
      } catch (error) {
        // No unzip on this machine: the pure-JS checks above still cover the format.
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
    }

    expect((await readdir(target)).sort()).toEqual(["Artist - Song A.mp3", "b.wav"]);
    expect((await readFile(path.join(target, "Artist - Song A.mp3"))).equals(SONG_A)).toBe(true);
    expect((await readFile(path.join(target, "b.wav"))).equals(SONG_B)).toBe(true);
  });
});

describe("uniqueEntryNames", () => {
  it("numbers repeats, ignoring case, keeping the extension", () => {
    expect(uniqueEntryNames(["a.mp3", "A.mp3", "b", "b", "a.mp3"])).toEqual([
      "a.mp3",
      "A (2).mp3",
      "b",
      "b (2)",
      "a (3).mp3",
    ]);
  });
});
