// A minimal, read-only zip reader: entry metadata from the central directory, and the
// first bytes of an entry for sniffing. Nothing is ever extracted to disk, and an entry
// name is only ever a label — it is never used as a path.
import type { FileHandle } from "node:fs/promises";
import { constants, inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate. Anything else cannot be sniffed. */
  method: number;
  encrypted: boolean;
  localHeaderOffset: number;
}

export type ZipListing =
  | { ok: true; entries: ZipEntry[] }
  | { ok: false; kind: "not_a_zip" | "unsupported_zip"; reason: string };

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

const END_RECORD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;

/** Bounds on what a download is allowed to make this reader allocate. */
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

const STORED = 0;
const DEFLATE = 8;

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function findEndRecord(tail: Buffer): number {
  for (let offset = tail.length - END_RECORD_BYTES; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

/** Lists the entries of a zip from its central directory. */
export async function listZipEntries(file: FileHandle, fileSize: number): Promise<ZipListing> {
  const tailLength = Math.min(fileSize, END_RECORD_BYTES + MAX_COMMENT_BYTES);
  const tail = await readAt(file, fileSize - tailLength, tailLength);
  const endOffset = findEndRecord(tail);
  if (endOffset === -1) {
    return { ok: false, kind: "not_a_zip", reason: "it has no zip directory (truncated archive?)" };
  }

  const entryCount = tail.readUInt16LE(endOffset + 10);
  const directorySize = tail.readUInt32LE(endOffset + 12);
  const directoryOffset = tail.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return { ok: false, kind: "unsupported_zip", reason: "it is a zip64 archive" };
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || entryCount > MAX_ENTRIES) {
    return {
      ok: false,
      kind: "unsupported_zip",
      reason: "its zip directory is unreasonably large",
    };
  }
  if (directoryOffset + directorySize > fileSize) {
    return { ok: false, kind: "not_a_zip", reason: "its zip directory points outside the file" };
  }

  const directory = await readAt(file, directoryOffset, directorySize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + CENTRAL_HEADER_BYTES > directory.length ||
      directory.readUInt32LE(offset) !== CENTRAL_FILE_HEADER
    ) {
      return { ok: false, kind: "not_a_zip", reason: "its zip directory is corrupt" };
    }
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    entries.push({
      name: directory.toString("utf8", offset + 46, offset + 46 + nameLength),
      encrypted: (directory.readUInt16LE(offset + 8) & 0x1) === 0x1,
      method: directory.readUInt16LE(offset + 10),
      compressedSize: directory.readUInt32LE(offset + 20),
      uncompressedSize: directory.readUInt32LE(offset + 24),
      localHeaderOffset: directory.readUInt32LE(offset + 42),
    });
    offset += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
  }
  return { ok: true, entries };
}

/** Compressed bytes to read: enough for any header, small enough to inflate safely. */
const HEAD_COMPRESSED_BYTES = 4 * 1024;
const HEAD_INFLATED_LIMIT = 8 * 1024 * 1024;

/**
 * The first bytes of an entry's content, in memory, or `null` when they cannot be read
 * (encrypted, an unusual compression method, or a corrupt entry).
 */
export async function readEntryHead(
  file: FileHandle,
  entry: ZipEntry,
  byteCount: number,
): Promise<Buffer | null> {
  if (entry.encrypted || (entry.method !== STORED && entry.method !== DEFLATE)) return null;

  const header = await readAt(file, entry.localHeaderOffset, LOCAL_HEADER_BYTES);
  if (header.length < LOCAL_HEADER_BYTES || header.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    return null;
  }
  const dataOffset =
    entry.localHeaderOffset +
    LOCAL_HEADER_BYTES +
    header.readUInt16LE(26) +
    header.readUInt16LE(28);
  const raw = await readAt(file, dataOffset, Math.min(entry.compressedSize, HEAD_COMPRESSED_BYTES));

  if (entry.method === STORED) return raw.subarray(0, byteCount);
  try {
    // The input is cut short on purpose, so flush what there is instead of failing.
    const inflated = inflateRawSync(raw, {
      finishFlush: constants.Z_SYNC_FLUSH,
      maxOutputLength: HEAD_INFLATED_LIMIT,
    });
    return inflated.subarray(0, byteCount);
  } catch {
    // Not valid deflate data: the caller treats the entry as unreadable.
    return null;
  }
}
