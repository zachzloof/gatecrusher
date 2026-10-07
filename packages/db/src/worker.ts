// The worker's side of the queue: which job runs next, and the heartbeat web reads.
// The queue is the `jobs` table itself; there is no separate broker.
import type { WorkerHeartbeat } from "@gatecrusher/core";
import { asc, eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { jobs, tracks, workerHeartbeat } from "./schema.ts";

/**
 * The job the worker should run next, or `null` when nothing is queued. Oldest run
 * first, then playlist order. A job the human sent back keeps its original run, so it
 * goes ahead of tracks queued after it.
 */
export async function nextQueuedJobId(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tracks, eq(jobs.trackId, tracks.id))
    .where(eq(jobs.status, "QUEUED"))
    .orderBy(asc(jobs.createdAt), asc(tracks.position), asc(jobs.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Jobs a previous worker left RUNNING when it died. Only one worker runs at a time, so
 * at start-up nothing else can be running them; `startJob` recovers each one.
 */
export async function interruptedJobIds(db: Database): Promise<string[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(tracks, eq(jobs.trackId, tracks.id))
    .where(eq(jobs.status, "RUNNING"))
    .orderBy(asc(jobs.createdAt), asc(tracks.position), asc(jobs.id));
  return rows.map((row) => row.id);
}

export async function writeWorkerHeartbeat(
  db: Database,
  beat: { pid: number; startedAt: Date; beatAt: Date },
): Promise<void> {
  await db
    .insert(workerHeartbeat)
    .values({ id: 1, ...beat })
    .onConflictDoUpdate({ target: workerHeartbeat.id, set: beat });
}

/** Removes the heartbeat, but only this worker's: a newer worker may already beat. */
export async function clearWorkerHeartbeat(db: Database, pid: number): Promise<void> {
  await db.delete(workerHeartbeat).where(eq(workerHeartbeat.pid, pid));
}

/** The last heartbeat, fresh or not, or `null` when no worker has one. */
export async function readWorkerHeartbeat(db: Database): Promise<WorkerHeartbeat | null> {
  const [row] = await db.select().from(workerHeartbeat).where(eq(workerHeartbeat.id, 1));
  if (row === undefined) return null;
  return {
    pid: row.pid,
    startedAt: row.startedAt.toISOString(),
    beatAt: row.beatAt.toISOString(),
  };
}
