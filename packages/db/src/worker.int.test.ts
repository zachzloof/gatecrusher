import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./client.ts";
import { savePlaylistIngest, type ClassifiedTrack } from "./playlists.ts";
import { cancelPlaylistRun, startPlaylistRun } from "./runs.ts";
import { jobs, playlists, workerHeartbeat } from "./schema.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";
import {
  clearWorkerHeartbeat,
  interruptedJobIds,
  nextQueuedJobId,
  readWorkerHeartbeat,
  writeWorkerHeartbeat,
} from "./worker.ts";

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.handle.db;
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await db.delete(playlists);
  await db.delete(workerHeartbeat);
});

function track(id: string): ClassifiedTrack {
  return {
    soundcloudId: id,
    title: `Track ${id}`,
    artist: "Fixture Artist",
    permalinkUrl: `https://soundcloud.com/fixture-artist/track-${id}`,
    artworkUrl: null,
    durationMs: 300_000,
    purchaseUrl: null,
    purchaseTitle: null,
    downloadable: true,
    classification: "native",
    gatePlatform: null,
  };
}

async function queuedPlaylist(name: string, trackIds: readonly string[]): Promise<string[]> {
  const { playlistId } = await savePlaylistIngest(db, {
    soundcloudUrl: `https://soundcloud.com/fixture-curator/sets/${name}`,
    source: "api_v2",
    soundcloudId: name,
    title: name,
    owner: "fixture-curator",
    artworkUrl: null,
    tracks: trackIds.map((id) => track(`${name}-${id}`)),
  });
  const run = await startPlaylistRun(db, playlistId);
  if (!run.ok) throw new Error(run.reason);
  return run.newJobIds;
}

async function setStatus(jobId: string, status: "RUNNING" | "SUCCEEDED"): Promise<void> {
  await db.update(jobs).set({ status }).where(eq(jobs.id, jobId));
}

describe("nextQueuedJobId", () => {
  it("is null when nothing is queued", async () => {
    expect(await nextQueuedJobId(db)).toBeNull();
  });

  it("takes the oldest run first, then playlist order", async () => {
    const first = await queuedPlaylist("first", ["a", "b"]);
    const second = await queuedPlaylist("second", ["a"]);

    const order: string[] = [];
    for (let next = await nextQueuedJobId(db); next !== null; next = await nextQueuedJobId(db)) {
      order.push(next);
      await setStatus(next, "SUCCEEDED");
    }

    expect(order).toEqual([...first, ...second]);
  });

  it("skips running and cancelled jobs", async () => {
    const [running, queued] = await queuedPlaylist("mixed", ["a", "b"]);
    if (running === undefined || queued === undefined) throw new Error("expected two jobs");
    await setStatus(running, "RUNNING");

    expect(await nextQueuedJobId(db)).toBe(queued);

    const [playlist] = await db.select({ id: playlists.id }).from(playlists);
    await cancelPlaylistRun(db, playlist?.id ?? "");
    expect(await nextQueuedJobId(db)).toBeNull();
  });
});

describe("interruptedJobIds", () => {
  it("lists the jobs left running, in queue order", async () => {
    const ids = await queuedPlaylist("crashed", ["a", "b", "c"]);
    const [a, , c] = ids;
    if (a === undefined || c === undefined) throw new Error("expected three jobs");
    await setStatus(c, "RUNNING");
    await setStatus(a, "RUNNING");

    expect(await interruptedJobIds(db)).toEqual([a, c]);
  });
});

describe("worker heartbeat", () => {
  const startedAt = new Date("2026-10-07T10:00:00.000Z");

  it("is null until a worker beats", async () => {
    expect(await readWorkerHeartbeat(db)).toBeNull();
  });

  it("keeps one row, rewritten on every beat", async () => {
    await writeWorkerHeartbeat(db, { pid: 7, startedAt, beatAt: startedAt });
    await writeWorkerHeartbeat(db, {
      pid: 7,
      startedAt,
      beatAt: new Date("2026-10-07T10:00:05.000Z"),
    });

    expect(await readWorkerHeartbeat(db)).toEqual({
      pid: 7,
      startedAt: "2026-10-07T10:00:00.000Z",
      beatAt: "2026-10-07T10:00:05.000Z",
    });
    expect(await db.$count(workerHeartbeat)).toBe(1);
  });

  it("is cleared only by the worker that wrote it", async () => {
    await writeWorkerHeartbeat(db, { pid: 8, startedAt, beatAt: startedAt });

    await clearWorkerHeartbeat(db, 7);
    expect(await readWorkerHeartbeat(db)).not.toBeNull();

    await clearWorkerHeartbeat(db, 8);
    expect(await readWorkerHeartbeat(db)).toBeNull();
  });
});
