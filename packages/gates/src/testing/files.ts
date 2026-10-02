// Test files, generated in memory: nothing binary is committed. Each is a valid header
// followed by incompressible padding, so a zip of one stays as big as it looks.
import { randomBytes } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

/** Comfortably above the 1 MB default threshold. */
export const BIG_ENOUGH_BYTES = 1_200_000;

function padded(header: Buffer, sizeBytes: number): Buffer {
  return Buffer.concat([header, randomBytes(Math.max(0, sizeBytes - header.length))]);
}

/** An ID3v2 tag header followed by an MPEG-1 Layer III frame header. */
export function fakeMp3(sizeBytes = BIG_ENOUGH_BYTES): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return padded(Buffer.concat([id3, frame]), sizeBytes);
}

export function fakeWav(sizeBytes = BIG_ENOUGH_BYTES): Buffer {
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(Math.max(0, sizeBytes - 8), 4);
  header.write("WAVE", 8, "ascii");
  return padded(header, sizeBytes);
}

/** What a gate serves when the file is gone: an error page, whatever its file name says. */
export function fakeHtmlPage(sizeBytes = BIG_ENOUGH_BYTES): Buffer {
  const html = "<!DOCTYPE html><html><body><h1>File not found</h1></body></html>";
  return Buffer.concat([
    Buffer.from(html),
    Buffer.alloc(Math.max(0, sizeBytes - html.length), 0x20),
  ]);
}

export interface FakeZipEntry {
  name: string;
  data: Buffer;
  /** Defaults to "stored". */
  method?: "stored" | "deflate";
}

/** A real zip archive: local headers, data, central directory, end record. */
export function fakeZip(entries: readonly FakeZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflate = entry.method === "deflate";
    const body = deflate ? deflateRawSync(entry.data) : entry.data;
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}
