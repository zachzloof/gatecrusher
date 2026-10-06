// Test doubles for the SoundCloud clients. Everything here is offline: the fake fetch
// rejects any URL it was not told about.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ProcessResult, ProcessRunner } from "./process-runner";
import type { FetchLike } from "./types";

export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

/** Obviously fake, but the shape discovery looks for. */
export const FIXTURE_CLIENT_ID = "fixtureClientId00000000000000001";
export const STALE_CLIENT_ID = "staleClientId0000000000000000002";

interface FakeResponse {
  status: number;
  body: unknown;
}

export interface FakeSoundcloudOptions {
  /** What `/resolve` answers. Default: the fixture playlist. */
  resolve?: FakeResponse | (() => FakeResponse);
  /** Hydrated tracks `/tracks?ids=` can return. Default: the fixture batch. */
  tracks?: ReadonlyArray<{ id: number }>;
  /** The only `client_id` api-v2 accepts. `null` rejects every id with 401. */
  acceptedClientId?: string | null;
  /** Status api-v2 uses to reject a `client_id`. */
  rejectStatus?: 401 | 403;
  /** Status of the soundcloud.com home page. */
  homeStatus?: number;
  /** The login token `/me` accepts, and who it belongs to. Default: none is accepted. */
  me?: { token: string; status?: number; body: unknown };
}

export interface FakeSoundcloud {
  fetch: FetchLike;
  /** Every requested URL, in order. */
  requests: URL[];
  /** The headers sent with each request, in the same order. */
  headers: Array<Record<string, string>>;
  count(pathname: string): number;
}

/** A fetch that plays soundcloud.com, its asset CDN and api-v2 from fixtures. */
export function createFakeSoundcloud(options: FakeSoundcloudOptions = {}): FakeSoundcloud {
  const accepted =
    options.acceptedClientId === undefined ? FIXTURE_CLIENT_ID : options.acceptedClientId;
  const tracks =
    options.tracks ??
    z.array(z.looseObject({ id: z.number() })).parse(fixtureJson("tracks-hydrated.json"));
  const requests: URL[] = [];
  const headers: Array<Record<string, string>> = [];

  const json = ({ status, body }: FakeResponse): Response => Response.json(body, { status });

  const answer = (url: URL, sent: Record<string, string>): Response => {
    if (url.origin === "https://soundcloud.com" && url.pathname === "/") {
      return new Response(fixtureText("home.html"), { status: options.homeStatus ?? 200 });
    }
    if (url.origin === "https://a-v2.sndcdn.com") {
      // The id lives in the middle bundle, so discovery has to look past the last one.
      const body = url.pathname.endsWith("49-fixture-app.js")
        ? `(()=>{var o={app_version:"1",client_id:"${FIXTURE_CLIENT_ID}",env:"production"}})();`
        : `(()=>{console.log("no id here")})();`;
      return new Response(body, { status: 200 });
    }
    if (url.origin === "https://api-v2.soundcloud.com") {
      if (url.searchParams.get("client_id") !== accepted) {
        return json({ status: options.rejectStatus ?? 401, body: {} });
      }
      if (url.pathname === "/resolve") {
        const resolve = options.resolve ?? {
          status: 200,
          body: fixtureJson("resolve-playlist.json"),
        };
        return json(typeof resolve === "function" ? resolve() : resolve);
      }
      if (url.pathname === "/me") {
        const { me } = options;
        if (me === undefined || sent.Authorization !== `OAuth ${me.token}`) {
          return json({ status: 401, body: {} });
        }
        return json({ status: me.status ?? 200, body: me.body });
      }
      if (url.pathname === "/tracks") {
        const ids = new Set((url.searchParams.get("ids") ?? "").split(",").map(Number));
        return json({ status: 200, body: tracks.filter((track) => ids.has(track.id)) });
      }
    }
    throw new Error(`Offline test tried to fetch ${url.origin}${url.pathname}`);
  };

  return {
    requests,
    headers,
    count: (pathname) => requests.filter((url) => url.pathname === pathname).length,
    fetch: (input, init) => {
      const url = new URL(input);
      const sent = init?.headers ?? {};
      requests.push(url);
      headers.push(sent);
      try {
        return Promise.resolve(answer(url, sent));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

export interface FakeRunner extends ProcessRunner {
  calls: Array<{ command: string; args: readonly string[] }>;
}

export function createFakeRunner(result: ProcessResult): FakeRunner {
  const calls: FakeRunner["calls"] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(result);
    },
  };
}
