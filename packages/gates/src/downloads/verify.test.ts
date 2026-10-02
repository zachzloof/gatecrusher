import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIG_ENOUGH_BYTES, fakeHtmlPage, fakeMp3, fakeWav, fakeZip } from "../testing/files.ts";
import { sniffAudio } from "./sniff.ts";
import { verifyDownload } from "./verify.ts";

const MIN_BYTES = 1_048_576;

let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "gatecrusher-verify-"));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function saved(name: string, body: Buffer): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, body);
  return filePath;
}

describe("sniffAudio", () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const text = (value: string) => Uint8Array.from(Buffer.from(value, "latin1"));

  it.each([
    ["an ID3 tag", text("ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000"), "audio/mpeg"],
    ["a bare MPEG frame", bytes(0xff, 0xfb, 0x90, 0x00), "audio/mpeg"],
    ["WAV", text("RIFF\u0000\u0000\u0000\u0000WAVEfmt "), "audio/wav"],
    ["AIFF", text("FORM\u0000\u0000\u0000\u0000AIFFCOMM"), "audio/aiff"],
    ["FLAC", bytes(0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22), "audio/flac"],
    ["Ogg", text("OggS\u0000\u0002"), "audio/ogg"],
    ["M4A", text("\u0000\u0000\u0000 ftypM4A \u0000\u0000"), "audio/mp4"],
    ["ADTS AAC", bytes(0xff, 0xf1, 0x50, 0x80), "audio/aac"],
  ])("recognises %s", (_label, head, mimeType) => {
    expect(sniffAudio(head)?.mimeType).toBe(mimeType);
  });

  it.each([
    ["HTML", text("<!DOCTYPE html><html>")],
    ["JSON", text('{"error":"gone"}')],
    ["a zip", bytes(0x50, 0x4b, 0x03, 0x04)],
    ["a RIFF that is not WAVE", text("RIFF\u0000\u0000\u0000\u0000AVI LIST")],
    ["an MP4 video brand", text("\u0000\u0000\u0000 ftypqt  \u0000\u0000")],
    ["0xFF followed by junk", bytes(0xff, 0xff, 0xff, 0xff)],
    ["nothing", bytes()],
    ["a PNG", bytes(0x89, 0x50, 0x4e, 0x47)],
  ])("rejects %s", (_label, head) => {
    expect(sniffAudio(head)).toBeNull();
  });
});

describe("verifyDownload", () => {
  it("accepts audio above the threshold and reports size, type and checksum", async () => {
    const body = fakeMp3();
    const result = await verifyDownload(await saved("ok.bin", body), { minBytes: MIN_BYTES });

    expect(result).toMatchObject({
      ok: true,
      kind: "audio",
      mimeType: "audio/mpeg",
      extension: "mp3",
      sizeBytes: body.length,
    });
    expect(result.ok && result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("names the type from the bytes, not from the file name", async () => {
    const result = await verifyDownload(await saved("claims-to-be.mp3", fakeWav()), {
      minBytes: MIN_BYTES,
    });

    expect(result).toMatchObject({ ok: true, mimeType: "audio/wav", extension: "wav" });
  });

  it("gives the same checksum for the same bytes", async () => {
    const body = fakeMp3();
    const first = await verifyDownload(await saved("a.bin", body), { minBytes: MIN_BYTES });
    const second = await verifyDownload(await saved("b.bin", body), { minBytes: MIN_BYTES });

    expect(first.ok && second.ok && first.checksumSha256 === second.checksumSha256).toBe(true);
  });

  it("rejects a file that does not exist", async () => {
    const result = await verifyDownload(path.join(directory, "never-saved.mp3"), {
      minBytes: MIN_BYTES,
    });

    expect(result).toMatchObject({ ok: false, kind: "missing" });
  });

  it("rejects a tiny file even when it is real audio", async () => {
    const result = await verifyDownload(await saved("tiny.mp3", fakeMp3(2_048)), {
      minBytes: MIN_BYTES,
    });

    expect(result).toMatchObject({ ok: false, kind: "too_small" });
  });

  it("rejects an HTML error page saved as .mp3", async () => {
    const result = await verifyDownload(await saved("error.mp3", fakeHtmlPage()), {
      minBytes: MIN_BYTES,
    });

    expect(result).toEqual({ ok: false, kind: "not_audio", reason: "it is an HTML page" });
  });

  it("honours a custom threshold", async () => {
    const filePath = await saved("small.mp3", fakeMp3(4_096));

    expect((await verifyDownload(filePath, { minBytes: 4_096 })).ok).toBe(true);
    expect((await verifyDownload(filePath, { minBytes: 4_097 })).ok).toBe(false);
  });

  it("accepts a zip holding a big-enough audio entry, as an archive", async () => {
    const body = fakeZip([
      { name: "artwork/cover.jpg", data: Buffer.from("jpeg, allegedly") },
      { name: "Fixture Artist - Fixture Track.mp3", data: fakeMp3() },
    ]);
    const result = await verifyDownload(await saved("pack.zip", body), { minBytes: MIN_BYTES });

    expect(result).toMatchObject({
      ok: true,
      kind: "archive",
      mimeType: "application/zip",
      extension: "zip",
      sizeBytes: body.length,
    });
  });

  it("sniffs a deflated entry instead of trusting its name", async () => {
    const audio = fakeZip([{ name: "track.bin", data: fakeMp3(), method: "deflate" }]);
    const impostor = fakeZip([
      { name: "track.mp3", data: fakeHtmlPage(BIG_ENOUGH_BYTES * 4), method: "deflate" },
    ]);

    // The HTML page is mostly spaces and deflates to a few kilobytes, hence the low
    // threshold: the entry is "big enough" and named like audio, but its bytes are not.
    expect((await verifyDownload(await saved("a.zip", audio), { minBytes: MIN_BYTES })).ok).toBe(
      true,
    );
    expect(await verifyDownload(await saved("b.zip", impostor), { minBytes: 1_024 })).toMatchObject(
      {
        ok: false,
        kind: "archive_without_audio",
      },
    );
  });

  it("rejects a zip with no audio in it", async () => {
    const body = fakeZip([{ name: "readme.txt", data: Buffer.alloc(BIG_ENOUGH_BYTES, 0x61) }]);
    const result = await verifyDownload(await saved("docs.zip", body), { minBytes: MIN_BYTES });

    expect(result).toMatchObject({ ok: false, kind: "archive_without_audio" });
  });

  it("rejects a zip whose only audio entry is below the threshold", async () => {
    const body = fakeZip([
      { name: "snippet.mp3", data: fakeMp3(50_000) },
      { name: "filler.dat", data: Buffer.alloc(BIG_ENOUGH_BYTES, 0x61) },
    ]);
    const result = await verifyDownload(await saved("snippet.zip", body), { minBytes: MIN_BYTES });

    expect(result).toMatchObject({ ok: false, kind: "archive_without_audio" });
  });

  it("rejects a truncated zip", async () => {
    const body = fakeZip([{ name: "track.mp3", data: fakeMp3() }]);
    const truncated = body.subarray(0, body.length - 4_000);
    const result = await verifyDownload(await saved("cut.zip", truncated), { minBytes: MIN_BYTES });

    expect(result).toMatchObject({ ok: false, kind: "bad_archive" });
  });

  it("never treats a hostile entry name as a path", async () => {
    const body = fakeZip([{ name: "../../../escape.mp3", data: fakeMp3() }]);
    const result = await verifyDownload(await saved("hostile.zip", body), { minBytes: MIN_BYTES });

    // Accepted as an archive and kept as delivered: nothing is extracted, so the name
    // is only ever a label.
    expect(result).toMatchObject({ ok: true, kind: "archive" });
  });
});
