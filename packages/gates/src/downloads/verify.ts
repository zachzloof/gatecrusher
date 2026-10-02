import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { DownloadKind } from "@gatecrusher/core";
import { describeNonAudio, isZip, sniffAudio, SNIFF_BYTES } from "./sniff.ts";
import { listZipEntries, readEntryHead, type ZipEntry } from "./zip.ts";

export interface VerifyOptions {
  /** A file — or, in an archive, an audio entry — smaller than this is never a success. */
  minBytes: number;
}

export type VerifyFailureKind =
  "missing" | "too_small" | "not_audio" | "bad_archive" | "archive_without_audio";

export type Verification =
  | {
      ok: true;
      kind: DownloadKind;
      mimeType: string;
      /** Extension to store the file under, without the dot. */
      extension: string;
      sizeBytes: number;
      checksumSha256: string;
    }
  | { ok: false; kind: VerifyFailureKind; reason: string };

/** Extensions that mark an audio entry whose bytes cannot be sniffed. */
const AUDIO_EXTENSIONS = /\.(mp3|wav|wave|flac|aif|aiff|aifc|m4a|aac|ogg|oga|opus|alac|wma)$/i;

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function isAudioEntry(file: FileHandle, entry: ZipEntry, minBytes: number): Promise<boolean> {
  if (entry.uncompressedSize < minBytes) return false;
  const head = await readEntryHead(file, entry, SNIFF_BYTES);
  // Bytes win when they can be read. The name only decides for entries that cannot be
  // sniffed (an unusual compression method), where it is the only evidence there is.
  return head === null ? AUDIO_EXTENSIONS.test(entry.name) : sniffAudio(head) !== null;
}

async function inspect(
  file: FileHandle,
  path: string,
  options: VerifyOptions,
): Promise<Verification> {
  const { size } = await file.stat();
  if (size < options.minBytes) {
    return {
      ok: false,
      kind: "too_small",
      reason: `it is ${size} bytes, below the ${options.minBytes}-byte minimum`,
    };
  }

  const head = Buffer.alloc(SNIFF_BYTES);
  const { bytesRead } = await file.read(head, 0, SNIFF_BYTES, 0);
  const leading = head.subarray(0, bytesRead);

  const audio = sniffAudio(leading);
  if (audio !== null) {
    return {
      ok: true,
      kind: "audio",
      mimeType: audio.mimeType,
      extension: audio.extension,
      sizeBytes: size,
      checksumSha256: await sha256(path),
    };
  }

  if (!isZip(leading)) {
    const sample = Buffer.alloc(64);
    const read = await file.read(sample, 0, sample.length, 0);
    return {
      ok: false,
      kind: "not_audio",
      reason: `it is ${describeNonAudio(sample.subarray(0, read.bytesRead))}`,
    };
  }

  const listing = await listZipEntries(file, size);
  if (!listing.ok) return { ok: false, kind: "bad_archive", reason: listing.reason };
  for (const entry of listing.entries) {
    if (await isAudioEntry(file, entry, options.minBytes)) {
      return {
        ok: true,
        kind: "archive",
        mimeType: "application/zip",
        extension: "zip",
        sizeBytes: size,
        checksumSha256: await sha256(path),
      };
    }
  }
  return {
    ok: false,
    kind: "archive_without_audio",
    reason: `it is a zip with no audio file of at least ${options.minBytes} bytes in it`,
  };
}

/**
 * Decides whether a saved file is a real download: it exists, is big enough, and its
 * bytes are audio or a zip holding at least one big-enough audio entry. Never throws for
 * a bad file — that is a result.
 */
export async function verifyDownload(path: string, options: VerifyOptions): Promise<Verification> {
  let file: FileHandle;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, kind: "missing", reason: "the file was not saved" };
    }
    throw error;
  }
  try {
    return await inspect(file, path, options);
  } finally {
    await file.close();
  }
}
