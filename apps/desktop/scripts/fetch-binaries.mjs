// Downloads the programs the desktop app ships with, for one platform, into
// vendor/<platform>-<arch>/:
//
//   postgres/   Postgres 17 (bin, lib, share), from the embedded-postgres npm packages
//   bin/        yt-dlp (+ yt-dlp.version), ffmpeg, ffprobe
//   licenses/   their licence texts
//
// Every download is checked against the checksum its publisher lists. Run on the
// platform you are building for (the Windows build also takes the Visual C++ runtime
// DLLs Postgres needs from this machine):
//
//   pnpm --filter @gatecrusher/desktop fetch-binaries [--arch=x64|arm64]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const POSTGRES_VERSION = "17.10.0-beta.17";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const platform = args.platform ?? process.platform;
const arch = args.arch ?? process.arch;
const target = `${platform}-${arch}`;

const SUPPORTED = {
  "win32-x64": { postgres: "windows-x64" },
  "darwin-arm64": { postgres: "darwin-arm64", ffmpeg: "arm64" },
  "darwin-x64": { postgres: "darwin-x64", ffmpeg: "amd64" },
};
const spec = SUPPORTED[target];
if (spec === undefined) {
  console.error(`Unsupported target ${target}. Supported: ${Object.keys(SUPPORTED).join(", ")}`);
  process.exit(1);
}
if (platform !== process.platform) {
  console.error(`Run this on ${platform}: it unpacks and checks binaries for this machine.`);
  process.exit(1);
}

const outDir = path.resolve(HERE, "..", "vendor", target);
const exe = (name) => (platform === "win32" ? `${name}.exe` : name);

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return { body: Buffer.from(await response.arrayBuffer()), finalUrl: response.url };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function expectChecksum(name, actual, expected) {
  if (expected === undefined) throw new Error(`No published checksum for ${name}`);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`${name}: checksum mismatch (got ${actual}, expected ${expected})`);
  }
  console.log(`  ${name}: checksum ok`);
}

/** "<hash>  <name>" lines, as sha256sum writes them. */
function parseSums(text) {
  return new Map(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+\*?/))
      .filter((parts) => parts.length === 2)
      .map(([hash, name]) => [name, hash]),
  );
}

async function unpack(archive, into) {
  await mkdir(into, { recursive: true });
  // bsdtar (Windows 10+, macOS) reads both .tgz and .zip.
  execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
}

async function findFile(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name);
  }
  throw new Error(`${name} not found in the archive`);
}

async function copyTree(from, to, skip = () => false) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination, skip);
    else if (entry.isFile()) await copyFile(source, destination);
  }
}

async function fetchPostgres(work) {
  console.log(`Postgres ${POSTGRES_VERSION} (${spec.postgres})`);
  const name = `@embedded-postgres/${spec.postgres}`;
  const meta = await (
    await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${POSTGRES_VERSION}`)
  ).json();
  const { body } = await download(meta.dist.tarball);
  const [algorithm, expected] = meta.dist.integrity.split("-");
  const actual = createHash(algorithm).update(body).digest("base64");
  if (actual !== expected) throw new Error(`${name}: integrity mismatch`);
  console.log(`  ${name}: integrity ok`);

  const archive = path.join(work, "postgres.tgz");
  await writeFile(archive, body);
  await unpack(archive, path.join(work, "postgres"));
  const native = path.join(work, "postgres", "package", "native");
  const into = path.join(outDir, "postgres");
  // pgAdmin's wxWidgets and a test plug-in are not needed to run the server.
  await copyTree(native, into, (entry) =>
    /^wx.*\.dll$|^testplug\.dll$|^pg-symlinks\.json$/.test(entry),
  );

  // npm cannot store symlinks; the package lists them. Real copies avoid link trouble
  // in packaging and signing.
  const links = JSON.parse(await readFile(path.join(native, "pg-symlinks.json"), "utf8"));
  for (const link of links) {
    const source = path.join(into, path.relative("native", link.source));
    const linkPath = path.join(into, path.relative("native", link.target));
    await copyFile(source, linkPath);
  }

  if (platform === "win32") {
    // Postgres is built with Visual C++ and needs its runtime, which not every PC has.
    // The runtime may be deployed next to the program that uses it.
    const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    for (const dll of ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]) {
      const source = path.join(system32, dll);
      if (!existsSync(source)) throw new Error(`${dll} is not installed on this machine`);
      await copyFile(source, path.join(into, "bin", dll));
    }
  } else {
    for (const tool of ["initdb", "pg_ctl", "postgres"]) {
      await chmod(path.join(into, "bin", tool), 0o755);
    }
  }
  await copyFile(
    path.join(work, "postgres", "package", "LICENSE.md"),
    path.join(outDir, "licenses", "postgres-embedded.md"),
  );
}

async function fetchYtDlp() {
  const asset = platform === "win32" ? "yt-dlp.exe" : "yt-dlp_macos";
  console.log(`yt-dlp (${asset})`);
  const latest = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest", {
    redirect: "manual",
  });
  const tag = latest.headers.get("location")?.split("/tag/")[1];
  if (tag === undefined) throw new Error("Could not find the latest yt-dlp release");
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
  const sums = parseSums((await download(`${base}/SHA2-256SUMS`)).body.toString("utf8"));
  const { body } = await download(`${base}/${asset}`);
  expectChecksum(asset, sha256(body), sums.get(asset));

  const file = path.join(outDir, "bin", exe("yt-dlp"));
  await writeFile(file, body);
  if (platform !== "win32") await chmod(file, 0o755);
  await writeFile(path.join(outDir, "bin", "yt-dlp.version"), `${tag}\n`);
  await writeFile(
    path.join(outDir, "licenses", "yt-dlp.txt"),
    `yt-dlp ${tag} is released into the public domain (The Unlicense).\nhttps://github.com/yt-dlp/yt-dlp\n`,
  );
}

async function fetchFfmpegWindows(work) {
  console.log("ffmpeg (yt-dlp's Windows build)");
  const base = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest";
  // The shared build: ffmpeg and ffprobe use one set of DLLs instead of carrying
  // ~165 MB each.
  const asset = "ffmpeg-master-latest-win64-gpl-shared.zip";
  const sums = parseSums((await download(`${base}/checksums.sha256`)).body.toString("utf8"));
  const { body } = await download(`${base}/${asset}`);
  expectChecksum(asset, sha256(body), sums.get(asset));

  const archive = path.join(work, asset);
  await writeFile(archive, body);
  await unpack(archive, path.join(work, "ffmpeg"));
  const binDir = path.dirname(await findFile(path.join(work, "ffmpeg"), "ffmpeg.exe"));
  for (const entry of await readdir(binDir)) {
    if (entry === "ffmpeg.exe" || entry === "ffprobe.exe" || entry.endsWith(".dll")) {
      await copyFile(path.join(binDir, entry), path.join(outDir, "bin", entry));
    }
  }
  await copyFile(
    await findFile(path.join(work, "ffmpeg"), "LICENSE.txt"),
    path.join(outDir, "licenses", "ffmpeg.txt"),
  );
}

async function fetchFfmpegMac(work) {
  console.log(`ffmpeg (Martin Riedl's macOS ${spec.ffmpeg} build)`);
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const { body, finalUrl } = await download(
      `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${spec.ffmpeg}/release/${tool}.zip`,
    );
    const published = (await download(`${finalUrl}.sha256`)).body.toString("utf8").trim();
    expectChecksum(`${tool}.zip`, sha256(body), published.split(/\s+/)[0]);
    const archive = path.join(work, `${tool}.zip`);
    await writeFile(archive, body);
    await unpack(archive, path.join(work, tool));
    const file = path.join(outDir, "bin", tool);
    await copyFile(await findFile(path.join(work, tool), tool), file);
    await chmod(file, 0o755);
  }
  await writeFile(
    path.join(outDir, "licenses", "ffmpeg.txt"),
    "ffmpeg and ffprobe: GPL builds from https://ffmpeg.martin-riedl.de (source: https://ffmpeg.org).\n",
  );
}

const work = await mkdtemp(path.join(tmpdir(), "gatecrusher-vendor-"));
try {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.join(outDir, "bin"), { recursive: true });
  await mkdir(path.join(outDir, "licenses"), { recursive: true });
  await fetchPostgres(work);
  await fetchYtDlp();
  if (platform === "win32") await fetchFfmpegWindows(work);
  else await fetchFfmpegMac(work);
  console.log(`Done: ${outDir}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
