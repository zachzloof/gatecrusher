// Shared by the worker's integration tests: a throwaway database, data dir and browser
// profile, the gates fixture server, and a headless browser that cannot leave localhost.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrackClassification } from "@gatecrusher/core";
import { savePlaylistIngest, schema, type Database } from "@gatecrusher/db";
import { createTestDatabase, type TestDatabase } from "@gatecrusher/db/testing";
import { createNativeAdapter, createRegistry } from "@gatecrusher/gates";
import {
  createZeroDelay,
  guardNetwork,
  NATIVE_FIXTURE_STATUSES,
  NATIVE_FIXTURES_DIR,
  nativeFixtureFiles,
  startFixtureServer,
  type FixtureServer,
  type NetworkGuard,
  type RecordingDelay,
} from "@gatecrusher/gates/testing";
import { eq } from "drizzle-orm";
import { chromium, type BrowserContext } from "playwright";
import type { BrowserLauncher } from "./browser.ts";

export interface WorkerTestBed {
  database: TestDatabase;
  db: Database;
  server: FixtureServer;
  /** Absolute path of the throwaway data dir. */
  dataDir: string;
  delay: RecordingDelay;
  /** The native adapter, pointed at the fixture server instead of soundcloud.com. */
  registry: ReturnType<typeof fixtureRegistry>;
  /** Headless, on a throwaway profile, and unable to leave localhost. */
  launchBrowser: BrowserLauncher;
  /** The browser context, once a job has opened it. */
  context(): BrowserContext | undefined;
  violations(): readonly string[];
  /** A playlist whose tracks point at the named fixture pages, in order. */
  seedPlaylist(pages: readonly FixturePage[]): Promise<{ playlistId: string; trackIds: string[] }>;
  close(): Promise<void>;
}

export interface FixturePage {
  name: string;
  query?: Readonly<Record<string, string>>;
  /** Defaults to native. */
  classification?: TrackClassification;
}

function fixtureRegistry() {
  return createRegistry([createNativeAdapter({ hosts: ["127.0.0.1"] })]);
}

export async function createWorkerTestBed(): Promise<WorkerTestBed> {
  const database = await createTestDatabase();
  const server = await startFixtureServer({
    fixturesDir: NATIVE_FIXTURES_DIR,
    files: nativeFixtureFiles(),
    statuses: NATIVE_FIXTURE_STATUSES,
  });
  const dataDir = await mkdtemp(path.join(tmpdir(), "gatecrusher-worker-"));

  let context: BrowserContext | undefined;
  let guard: NetworkGuard | undefined;
  let seeded = 0;

  return {
    database,
    db: database.handle.db,
    server,
    dataDir,
    delay: createZeroDelay(),
    registry: fixtureRegistry(),
    launchBrowser: async (profileDir) => {
      // Headless is for tests against local fixtures only; the worker itself never is.
      context = await chromium.launchPersistentContext(profileDir, {
        headless: true,
        acceptDownloads: true,
      });
      guard = await guardNetwork(context);
      return context;
    },
    context: () => context,
    violations: () => guard?.violations ?? [],
    seedPlaylist: async (pages) => {
      seeded += 1;
      const { playlistId } = await savePlaylistIngest(database.handle.db, {
        soundcloudUrl: `https://soundcloud.com/fixture-curator/sets/fixture-crate-${seeded}`,
        source: "api_v2",
        soundcloudId: `playlist-${seeded}`,
        title: "Fixture Crate",
        owner: "fixture-curator",
        artworkUrl: null,
        tracks: pages.map((page, index) => ({
          soundcloudId: `track-${seeded}-${index}`,
          title: `Fixture Track ${index + 1}`,
          artist: "Fixture Artist",
          permalinkUrl: server.pageUrl(page.name, page.query),
          artworkUrl: null,
          durationMs: 300_000,
          purchaseUrl: null,
          purchaseTitle: null,
          downloadable: (page.classification ?? "native") === "native",
          classification: page.classification ?? "native",
          gatePlatform: null,
        })),
      });
      const rows = await database.handle.db
        .select({ id: schema.tracks.id, position: schema.tracks.position })
        .from(schema.tracks)
        .where(eq(schema.tracks.playlistId, playlistId));
      rows.sort((a, b) => a.position - b.position);
      return { playlistId, trackIds: rows.map((row) => row.id) };
    },
    close: async () => {
      await context?.close();
      await server.close();
      await database.drop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
