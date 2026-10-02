import { z } from "zod";

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "WAITING_FOR_HUMAN",
  "SUCCEEDED",
  "MANUAL",
  "FAILED",
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const JOB_TRANSITION_EVENTS = [
  "start", // the worker picked the job up
  "succeed", // download verified
  "needs_human", // captcha, email confirmation, login challenge, unexpected page
  "impossible", // dead link, file gone, account required
  "fail", // crash / infrastructure
  "recover", // worker restarted mid-step; re-queue from the checkpoint
  "continue", // the human clicked Continue
  "give_up", // the human clicked Give up
  "retry", // the human clicked Retry on a failed job
] as const;
export const jobTransitionEventSchema = z.enum(JOB_TRANSITION_EVENTS);
export type JobTransitionEvent = z.infer<typeof jobTransitionEventSchema>;

/** The whole job lifecycle. Anything not listed here is an illegal transition. */
const TRANSITIONS: Readonly<
  Record<JobStatus, Readonly<Partial<Record<JobTransitionEvent, JobStatus>>>>
> = {
  QUEUED: { start: "RUNNING" },
  RUNNING: {
    succeed: "SUCCEEDED",
    needs_human: "WAITING_FOR_HUMAN",
    impossible: "MANUAL",
    fail: "FAILED",
    recover: "QUEUED",
  },
  WAITING_FOR_HUMAN: { continue: "QUEUED", give_up: "MANUAL" },
  FAILED: { retry: "QUEUED" },
  SUCCEEDED: {},
  MANUAL: {},
};

export type TransitionResult =
  { ok: true; status: JobStatus } | { ok: false; kind: "illegal_transition"; reason: string };

/**
 * The single place a job status may change. Nothing writes a job status without
 * going through this function first.
 */
export function transition(from: JobStatus, event: JobTransitionEvent): TransitionResult {
  const next = TRANSITIONS[from][event];
  if (next === undefined) {
    return {
      ok: false,
      kind: "illegal_transition",
      reason: `A ${from} job cannot handle "${event}"`,
    };
  }
  return { ok: true, status: next };
}
