// Builds everything the desktop app runs and lays it out as the installer will:
//
//   dist/                 the Electron main process, preloads and the gate window
//   stage/web/            the Next.js standalone server (pnpm links resolved)
//   stage/worker/         the worker, bundled into one file, without Playwright
//   stage/migrations/     the SQL migrations
//   stage/bin/            yt-dlp, ffmpeg, ffprobe     (from vendor/, see fetch-binaries)
//   stage/postgres/       Postgres                    (from vendor/)
//   stage/licenses/       licences of what is shipped
//
//   pnpm --filter @gatecrusher/desktop bundle [--arch=x64|arm64] [--skip-web]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, "..");
const REPO = path.resolve(DESKTOP, "..", "..");
const WEB = path.join(REPO, "apps", "web");
const DIST = path.join(DESKTOP, "dist");
const STAGE = path.join(DESKTOP, "stage");

const args = new Set(process.argv.slice(2));
const arch = [...args].find((arg) => arg.startsWith("--arch="))?.split("=")[1] ?? process.arch;
const vendor = path.join(DESKTOP, "vendor", `${process.platform}-${arch}`);

// ESM bundles of CommonJS dependencies still call require() and use __dirname.
const esmBanner = {
  js: [
    'import { createRequire as __gcCreateRequire } from "node:module";',
    'import { fileURLToPath as __gcFileURLToPath } from "node:url";',
    'import { dirname as __gcDirname } from "node:path";',
    "const require = __gcCreateRequire(import.meta.url);",
    "const __filename = __gcFileURLToPath(import.meta.url);",
    "const __dirname = __gcDirname(__filename);",
  ].join("\n"),
};

const node = {
  bundle: true,
  platform: "node",
  target: "node24",
  logLevel: "warning",
  legalComments: "none",
};

function step(message) {
  process.stdout.write(`\n> ${message}\n`);
}

async function bundleDesktop() {
  step("Desktop: main process, preloads, gate window");
  await rm(DIST, { recursive: true, force: true });
  await build({
    ...node,
    entryPoints: [path.join(DESKTOP, "src", "main", "index.ts")],
    outfile: path.join(DIST, "main.mjs"),
    format: "esm",
    external: ["electron"],
    banner: esmBanner,
  });
  for (const name of ["gate", "app"]) {
    await build({
      ...node,
      entryPoints: [path.join(DESKTOP, "src", "preload", `${name}.ts`)],
      outfile: path.join(DIST, `preload-${name}.cjs`),
      format: "cjs",
      external: ["electron"],
    });
  }
  await build({
    bundle: true,
    platform: "browser",
    target: "chrome130",
    format: "iife",
    logLevel: "warning",
    entryPoints: [path.join(DESKTOP, "src", "renderer", "gate.ts")],
    outfile: path.join(DIST, "renderer", "gate.js"),
  });
  await cp(
    path.join(DESKTOP, "src", "renderer", "gate.html"),
    path.join(DIST, "renderer", "gate.html"),
  );
}

async function bundleWorker() {
  step("Worker: one file, Playwright replaced by a stub");
  await build({
    ...node,
    entryPoints: [path.join(DESKTOP, "src", "worker-entry.ts")],
    outfile: path.join(STAGE, "worker", "worker.mjs"),
    format: "esm",
    banner: esmBanner,
    alias: { playwright: path.join(DESKTOP, "src", "shims", "playwright.ts") },
  });
}

// Next.js's standalone output keeps pnpm's layout: packages are links into
// node_modules/.pnpm, and each package finds its dependencies next to its real location
// there. An installer cannot carry links (and on Windows, Next.js writes pnpm's
// directory links as file symlinks, which the OS refuses to follow). So links are read
// here, not followed by the OS, and each linked package is copied with its dependencies
// nested in its own node_modules, the layout Node resolves without any links.

/** Where a link finally points, read link by link. */
async function realPath(start) {
  let current = start;
  for (let hops = 0; hops < 40; hops += 1) {
    if (!(await lstat(current)).isSymbolicLink()) return current;
    current = path.resolve(path.dirname(current), await readlink(current));
  }
  throw new Error(`Too many links at ${start}`);
}

function inPnpmStore(file) {
  return file.split(path.sep).includes(".pnpm");
}

/** The node_modules folder a pnpm package sits in: its other entries are its dependencies. */
function pnpmSiblings(packageDir) {
  const parent = path.dirname(packageDir);
  return path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
}

async function packageNames(nodeModules) {
  const names = [];
  for (const entry of await readdir(nodeModules)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const inner of await readdir(path.join(nodeModules, entry))) {
        names.push(`${entry}/${inner}`);
      }
    } else {
      names.push(entry);
    }
  }
  return names;
}

/** One package from the pnpm store, with its dependencies under its own node_modules. */
async function copyPackage(packageDir, to, ancestors) {
  await copyTree(packageDir, to, ancestors);
  if (!inPnpmStore(packageDir)) return;
  const siblings = pnpmSiblings(packageDir);
  const chain = new Set([...ancestors, packageDir]);
  for (const name of await packageNames(siblings)) {
    const dependency = await realPath(path.join(siblings, name));
    // Itself, or an ancestor: Node finds those by walking up.
    if (chain.has(dependency)) continue;
    await copyPackage(dependency, path.join(to, "node_modules", name), chain);
  }
}

async function copyTree(from, to, ancestors = new Set()) {
  const info = await lstat(from);
  if (info.isSymbolicLink()) {
    const target = await realPath(from);
    if (inPnpmStore(target)) await copyPackage(target, to, ancestors);
    else await copyTree(target, to, ancestors);
  } else if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      // The store itself is not shipped: every package in use is copied where it is linked.
      if (name === ".pnpm") continue;
      await copyTree(path.join(from, name), path.join(to, name), ancestors);
    }
  } else if (info.isFile()) {
    await copyFile(from, to);
  }
}

/** Fails the build if anything that is not code made it into the web server. */
async function assertNoUserData(root) {
  if (existsSync(path.join(root, "data"))) throw new Error("stage/web contains data/");
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    // Archives are only expected as dependencies' own test fixtures.
    const inDependency = file.split(path.sep).includes("node_modules");
    if (/\.(mp3|m4a|aac|wav|flac|aiff?|ogg|opus)$/i.test(entry.name)) {
      throw new Error(`stage/web contains an audio file: ${file}`);
    }
    if (/\.zip$/i.test(entry.name) && !inDependency) {
      throw new Error(`stage/web contains an archive: ${file}`);
    }
    if (entry.name === ".env" || entry.name.startsWith(".env.")) {
      throw new Error(`stage/web contains an env file: ${file}`);
    }
  }
}

async function bundleWeb() {
  if (!args.has("--skip-web")) {
    step("Web: Next.js standalone build");
    // pnpm is a .cmd on Windows, which only a shell can start; the arguments are fixed.
    execFileSync(
      process.platform === "win32" ? "pnpm --filter @gatecrusher/web build" : "pnpm",
      process.platform === "win32" ? [] : ["--filter", "@gatecrusher/web", "build"],
      {
        cwd: REPO,
        stdio: "inherit",
        shell: process.platform === "win32",
        env: { ...process.env, NEXT_OUTPUT: "standalone", NEXT_TELEMETRY_DISABLED: "1" },
      },
    );
  }
  step("Web: staging (pnpm links turned into nested node_modules)");
  const standalone = path.join(WEB, ".next", "standalone");
  const into = path.join(STAGE, "web");
  await copyTree(standalone, into);
  await cp(path.join(WEB, ".next", "static"), path.join(into, "apps", "web", ".next", "static"), {
    recursive: true,
  });
  if (existsSync(path.join(WEB, "public"))) {
    await cp(path.join(WEB, "public"), path.join(into, "apps", "web", "public"), {
      recursive: true,
    });
  }
  await assertNoUserData(into);
}

async function stageVendor() {
  step(`Binaries from vendor/${path.basename(vendor)}`);
  if (!existsSync(vendor)) {
    throw new Error(
      `vendor/${path.basename(vendor)} is missing. Run: pnpm --filter @gatecrusher/desktop fetch-binaries`,
    );
  }
  for (const name of ["bin", "postgres", "licenses"]) {
    await cp(path.join(vendor, name), path.join(STAGE, name), { recursive: true });
  }
  await cp(path.join(REPO, "packages", "db", "drizzle"), path.join(STAGE, "migrations"), {
    recursive: true,
  });
}

async function size(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await bundleDesktop();
await bundleWorker();
await bundleWeb();
await stageVendor();
const megabytes = (await size(STAGE)) / 1024 / 1024;
step(`Staged ${megabytes.toFixed(0)} MB in ${STAGE}`);
