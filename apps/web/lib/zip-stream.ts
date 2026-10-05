// A streaming zip writer for "download the whole playlist": files are stored, not
// compressed (audio does not compress), each one is streamed straight from disk, and
// sizes and checksums are written after the data (data descriptors), so nothing is
// buffered and the archive can start downloading at once. zip64 structures are used
// for files or archives at the 4 GiB limit of the original format.
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

export interface ZipEntryInput {
  /** Path inside the archive, with forward slashes. */
  name: string;
  /** Size in bytes, as recorded. Decides whether the entry needs zip64 up front. */
  sizeBytes: number;
  open(): Readable;
}

export interface ZipStreamOptions {
  /** Timestamp for every entry. Defaults to now. */
  modifiedAt?: Date;
  /** Writes zip64 structures regardless of size; for tests, since 4 GiB fixtures are not. */
  forceZip64?: boolean;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const DATA_DESCRIPTOR = 0x08074b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_LOCATOR = 0x07064b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** Bit 3: sizes and CRC follow the data. Bit 11: the name is UTF-8. */
const FLAGS = 0x0808;
const METHOD_STORED = 0;
const ZIP64_EXTRA_TAG = 0x0001;

const LIMIT_32 = 0xffffffff;
const LIMIT_16 = 0xffff;

/** MS-DOS time and date, as zip headers want them (local time, 2-second resolution). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface WrittenEntry {
  nameBytes: Buffer;
  zip64: boolean;
  offset: number;
  crc: number;
  size: number;
}

function localHeader(
  nameBytes: Buffer,
  zip64: boolean,
  stamp: { time: number; date: number },
): Buffer {
  const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (zip64) {
    // Sizes come in the data descriptor; the zip64 extra marks the entry as 64-bit.
    extra.writeUInt16LE(ZIP64_EXTRA_TAG, 0);
    extra.writeUInt16LE(16, 2);
  }
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER, 0);
  header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(METHOD_STORED, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(0, 14); // crc, in the descriptor
  header.writeUInt32LE(zip64 ? LIMIT_32 : 0, 18);
  header.writeUInt32LE(zip64 ? LIMIT_32 : 0, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, nameBytes, extra]);
}

function dataDescriptor(entry: WrittenEntry): Buffer {
  const descriptor = Buffer.alloc(entry.zip64 ? 24 : 16);
  descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0);
  descriptor.writeUInt32LE(entry.crc, 4);
  if (entry.zip64) {
    descriptor.writeBigUInt64LE(BigInt(entry.size), 8);
    descriptor.writeBigUInt64LE(BigInt(entry.size), 16);
  } else {
    descriptor.writeUInt32LE(entry.size, 8);
    descriptor.writeUInt32LE(entry.size, 12);
  }
  return descriptor;
}

function centralHeader(entry: WrittenEntry, stamp: { time: number; date: number }): Buffer {
  const sizeOverflows = entry.zip64 || entry.size >= LIMIT_32;
  const offsetOverflows = entry.zip64 || entry.offset >= LIMIT_32;
  const fields: bigint[] = [];
  if (sizeOverflows) fields.push(BigInt(entry.size), BigInt(entry.size));
  if (offsetOverflows) fields.push(BigInt(entry.offset));
  const extra = Buffer.alloc(fields.length === 0 ? 0 : 4 + fields.length * 8);
  if (fields.length > 0) {
    extra.writeUInt16LE(ZIP64_EXTRA_TAG, 0);
    extra.writeUInt16LE(fields.length * 8, 2);
    fields.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + index * 8));
  }

  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_FILE_HEADER, 0);
  header.writeUInt16LE(fields.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT, 4); // made by
  header.writeUInt16LE(fields.length > 0 ? VERSION_ZIP64 : VERSION_DEFAULT, 6); // needed
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(METHOD_STORED, 10);
  header.writeUInt16LE(stamp.time, 12);
  header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(sizeOverflows ? LIMIT_32 : entry.size, 20);
  header.writeUInt32LE(sizeOverflows ? LIMIT_32 : entry.size, 24);
  header.writeUInt16LE(entry.nameBytes.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(offsetOverflows ? LIMIT_32 : entry.offset, 42);
  return Buffer.concat([header, entry.nameBytes, extra]);
}

function endRecords(
  entryCount: number,
  directoryOffset: number,
  directorySize: number,
  zip64: boolean,
): Buffer {
  const parts: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(ZIP64_END_OF_CENTRAL_DIRECTORY, 0);
    record.writeBigUInt64LE(44n, 4); // size of the rest of this record
    record.writeUInt16LE(VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    record.writeUInt32LE(0, 16); // this disk
    record.writeUInt32LE(0, 20); // directory disk
    record.writeBigUInt64LE(BigInt(entryCount), 24);
    record.writeBigUInt64LE(BigInt(entryCount), 32);
    record.writeBigUInt64LE(BigInt(directorySize), 40);
    record.writeBigUInt64LE(BigInt(directoryOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_END_LOCATOR, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(record, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(zip64 ? LIMIT_16 : entryCount, 8);
  end.writeUInt16LE(zip64 ? LIMIT_16 : entryCount, 10);
  end.writeUInt32LE(zip64 ? LIMIT_32 : directorySize, 12);
  end.writeUInt32LE(zip64 ? LIMIT_32 : directoryOffset, 16);
  end.writeUInt16LE(0, 20);
  parts.push(end);
  return Buffer.concat(parts);
}

async function* zipChunks(
  entries: readonly ZipEntryInput[],
  options: ZipStreamOptions,
): AsyncGenerator<Buffer> {
  const stamp = dosDateTime(options.modifiedAt ?? new Date());
  const force = options.forceZip64 === true;
  const written: WrittenEntry[] = [];
  let offset = 0;

  for (const input of entries) {
    const nameBytes = Buffer.from(input.name, "utf8");
    const zip64 = force || input.sizeBytes >= LIMIT_32 || offset >= LIMIT_32;
    const entry: WrittenEntry = { nameBytes, zip64, offset, crc: 0, size: 0 };

    const header = localHeader(nameBytes, zip64, stamp);
    yield header;
    offset += header.length;

    for await (const chunk of input.open()) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      entry.crc = crc32(bytes, entry.crc);
      entry.size += bytes.length;
      offset += bytes.length;
      yield bytes;
    }
    if (!zip64 && entry.size >= LIMIT_32) {
      throw new Error(`"${input.name}" is larger than recorded and needs zip64`);
    }

    const descriptor = dataDescriptor(entry);
    yield descriptor;
    offset += descriptor.length;
    written.push(entry);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const entry of written) {
    const header = centralHeader(entry, stamp);
    yield header;
    directorySize += header.length;
  }

  const zip64 =
    force ||
    written.some((entry) => entry.zip64) ||
    written.length >= LIMIT_16 ||
    directoryOffset >= LIMIT_32 ||
    directorySize >= LIMIT_32;
  yield endRecords(written.length, directoryOffset, directorySize, zip64);
}

/** The archive as a Node stream. Errors from a file stream end the archive with an error. */
export function createZipStream(
  entries: readonly ZipEntryInput[],
  options: ZipStreamOptions = {},
): Readable {
  return Readable.from(zipChunks(entries, options));
}

/** `<title>`, `<title> (2)`, … so two files with the same name both make it into the zip. */
export function uniqueEntryNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), count);
    if (count === 1) return name;
    const dot = name.lastIndexOf(".");
    return dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  });
}
