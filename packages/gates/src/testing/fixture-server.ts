// A local HTTP server for adapter tests: hand-written fixture pages plus generated
// files to download. Tests never leave localhost — `guardNetwork` enforces it.
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { BrowserContext } from "playwright";

export interface FixtureFile {
  body: Buffer;
  /** What the server claims the file is. Verification must not believe it. */
  contentType: string;
  /** The file name the browser is told to save under. */
  fileName: string;
}

export interface FixtureServerOptions {
  /** Directory of `<name>.html` pages, served at `/fixture-artist/<name>`. */
  fixturesDir: string;
  /** Served at `/files/<key>` as attachments. */
  files?: Readonly<Record<string, FixtureFile>>;
  /** Pages answered with a status other than 200, by name. */
  statuses?: Readonly<Record<string, number>>;
}

export interface FixtureServer {
  origin: string;
  /** URL of a fixture page: `pageUrl("track", { file: "tiny" })`. */
  pageUrl(name: string, query?: Readonly<Record<string, string>>): string;
  /** How many times a path was requested: `hits("/files/audio")`. */
  hits(pathname: string): number;
  close(): Promise<void>;
}

/** Track pages live at a two-segment path, like `/<user>/<track>` on SoundCloud. */
const PAGE_PATH = /^\/fixture-artist\/([a-z0-9-]+)$/;
const FILE_PATH = /^\/files\/([a-z0-9-]+)$/;

const FAKE_CAPTCHA_FRAME =
  "<!DOCTYPE html><html><body><p>Fake captcha widget (test fixture)</p></body></html>";

export async function startFixtureServer(options: FixtureServerOptions): Promise<FixtureServer> {
  const counts = new Map<string, number>();

  const server: Server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);

    const send = (status: number, contentType: string, body: Buffer | string): void => {
      response.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(body);
    };

    if (pathname === "/fake/recaptcha/anchor") {
      send(200, "text/html; charset=utf-8", FAKE_CAPTCHA_FRAME);
      return;
    }

    const file = options.files?.[FILE_PATH.exec(pathname)?.[1] ?? ""];
    if (file !== undefined) {
      response.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.body.length,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
      });
      response.end(file.body);
      return;
    }

    const page = PAGE_PATH.exec(pathname)?.[1];
    if (page === undefined) {
      send(404, "text/plain; charset=utf-8", "No such fixture");
      return;
    }
    readFile(path.join(options.fixturesDir, `${page}.html`)).then(
      (html) => send(options.statuses?.[page] ?? 200, "text/html; charset=utf-8", html),
      () => send(404, "text/plain; charset=utf-8", "No such fixture"),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server is not listening on a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    pageUrl: (name, query = {}) => {
      const url = new URL(`/fixture-artist/${name}`, origin);
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      return url.toString();
    },
    hits: (pathname) => counts.get(pathname) ?? 0,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface NetworkGuard {
  /** Every URL a page tried to reach outside localhost. Must stay empty. */
  readonly violations: readonly string[];
}

/** Aborts and records any request that would leave localhost. */
export async function guardNetwork(context: BrowserContext): Promise<NetworkGuard> {
  const violations: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (LOCAL_HOSTS.has(new URL(url).hostname)) return route.continue();
    violations.push(url);
    return route.abort("blockedbyclient");
  });
  return { violations };
}
