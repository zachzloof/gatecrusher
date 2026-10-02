// Shared by the repository modules; not part of the package's public surface.
import {
  jobEventSchema,
  transition,
  type JobEvent,
  type JobTransitionEvent,
} from "@gatecrusher/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { events, jobs } from "./schema.ts";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type JobRow = typeof jobs.$inferSelect;

export type JobChangeFailure = {
  ok: false;
  kind: "job_not_found" | "illegal_transition";
  reason: string;
};

type JobPatch = Partial<
  Pick<
    typeof jobs.$inferInsert,
    | "adapterId"
    | "stepIndex"
    | "state"
    | "attempts"
    | "manualReason"
    | "manualDetail"
    | "manualLink"
    | "error"
    | "finishedAt"
  >
>;

/**
 * The only place a job's status is written. Locks the row, asks `transition()` whether
 * the change is legal, and applies it together with whatever else changes with it.
 */
export async function applyJobTransition(
  tx: Transaction,
  jobId: string,
  event: JobTransitionEvent,
  patch: JobPatch = {},
): Promise<{ ok: true; job: JobRow; from: JobRow["status"] } | JobChangeFailure> {
  const [current] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (current === undefined) {
    return { ok: false, kind: "job_not_found", reason: `No job ${jobId}` };
  }
  const next = transition(current.status, event);
  if (!next.ok) return next;

  const [job] = await tx
    .update(jobs)
    .set({ ...patch, status: next.status })
    .where(eq(jobs.id, jobId))
    .returning();
  if (job === undefined) throw new Error("Job update returned no row");
  return { ok: true, job, from: current.status };
}

/** Appends one event, validated against its schema first. */
export async function insertJobEvent(tx: Transaction | Database, event: JobEvent): Promise<void> {
  const parsed = jobEventSchema.parse(event);
  await tx.insert(events).values({
    runId: parsed.runId,
    jobId: parsed.jobId,
    type: parsed.type,
    stepIndex: "stepIndex" in parsed ? parsed.stepIndex : null,
    stepName: "stepName" in parsed ? parsed.stepName : null,
    screenshotPath: "screenshotPath" in parsed ? parsed.screenshotPath : null,
    error: parsed.type === "job_failed" ? parsed.error : null,
    payload: parsed,
  });
}
