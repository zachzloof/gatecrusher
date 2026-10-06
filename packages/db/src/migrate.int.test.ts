import { JOB_STATUSES, MANUAL_REASONS, TRACK_CLASSIFICATIONS } from "@gatecrusher/core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { jobs, playlists, runs, tracks } from "./schema.ts";
import { seed } from "./seed.ts";
import { createTestDatabase, type TestDatabase } from "./testing.ts";

// A brand-new, empty database per test file, so "applies to an empty database" is
// literally what is tested and the development database is never touched.
let database: TestDatabase;
let handle: DbHandle;
let databaseUrl: string;

beforeAll(async () => {
  database = await createTestDatabase({ migrate: false });
  ({ handle, url: databaseUrl } = database);
});

afterAll(async () => {
  await database.drop();
});

async function enumLabels(typeName: string): Promise<string[]> {
  const rows = await handle.db.execute<{ label: string }>(sql`
    select e.enumlabel as label
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = ${typeName}
    order by e.enumsortorder
  `);
  return rows.map((row) => row.label);
}

describe("migrations", () => {
  it("apply cleanly to an empty database", async () => {
    const before = await handle.db.execute<{ count: number }>(sql`
      select count(*)::int as count from information_schema.tables where table_schema = 'public'
    `);
    expect(before[0]?.count).toBe(0);

    await runMigrations(databaseUrl);

    const tables = await handle.db.execute<{ name: string }>(sql`
      select table_name as name from information_schema.tables
      where table_schema = 'public' order by table_name
    `);
    expect(tables.map((table) => table.name)).toEqual([
      "downloads",
      "events",
      "human_requests",
      "jobs",
      "playlists",
      "runs",
      "soundcloud_account",
      "tracks",
    ]);
  });

  it("are a no-op when run again", async () => {
    await expect(runMigrations(databaseUrl)).resolves.toBeUndefined();
  });

  it("create the classification, job status and manual reason enums from core", async () => {
    expect(await enumLabels("track_classification")).toEqual([...TRACK_CLASSIFICATIONS]);
    expect(await enumLabels("job_status")).toEqual([...JOB_STATUSES]);
    expect(await enumLabels("job_status")).toContain("WAITING_FOR_HUMAN");
    expect(await enumLabels("manual_reason")).toEqual([...MANUAL_REASONS]);
  });
});

describe("seed", () => {
  it("inserts a fake playlist with one track per classification, idempotently", async () => {
    const first = await seed(handle.db);
    const second = await seed(handle.db);

    expect(first.tracks).toBe(4);
    expect(second).toEqual(first);
    expect(await handle.db.$count(playlists)).toBe(1);

    const rows = await handle.db
      .select({ classification: tracks.classification })
      .from(tracks)
      .where(eq(tracks.playlistId, first.playlistId))
      .orderBy(tracks.position);
    expect(rows.map((row) => row.classification)).toEqual(["native", "gate", "buy", "none"]);
  });
});

describe("constraints", () => {
  it("refuse a MANUAL job without a reason and link", async () => {
    const { playlistId } = await seed(handle.db);
    const [track] = await handle.db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.playlistId, playlistId))
      .limit(1);
    const [run] = await handle.db.insert(runs).values({ playlistId }).returning({ id: runs.id });
    if (track === undefined || run === undefined) throw new Error("fixture rows missing");

    const [job] = await handle.db
      .insert(jobs)
      .values({ runId: run.id, trackId: track.id })
      .returning({ id: jobs.id, status: jobs.status });
    if (job === undefined) throw new Error("job insert returned no row");
    expect(job.status).toBe("QUEUED");

    await expect(
      handle.db.update(jobs).set({ status: "MANUAL" }).where(eq(jobs.id, job.id)),
    ).rejects.toThrow();

    await handle.db
      .update(jobs)
      .set({
        status: "MANUAL",
        manualReason: "dead_link",
        manualLink: "https://gate.example/gone",
      })
      .where(eq(jobs.id, job.id));
    const [updated] = await handle.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(updated?.status).toBe("MANUAL");
  });
});
