import { z } from "zod";
import { humanReasonSchema, manualReasonSchema } from "./domain.ts";
import { downloadedFileSchema, humanDescriptionSchema } from "./gate.ts";

/**
 * Emitted when a job parks for the human. Written to the `events` table and published
 * on Redis so the UI can show a Needs-you card. The `human_requests` row mirrors it.
 */
export const needsHumanEventSchema = z.object({
  type: z.literal("needs_human"),
  jobId: z.uuid(),
  trackId: z.uuid(),
  runId: z.uuid(),
  humanRequestId: z.uuid(),
  adapterId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  stepName: z.string().min(1),
  reason: humanReasonSchema,
  /** Instruction to the user. */
  description: humanDescriptionSchema,
  /** Relative to the data dir. */
  screenshotPath: z.string().min(1),
  pageUrl: z.url({ protocol: /^https?$/ }),
  /** False once the parked page was lost (worker restart, tab closed, TTL). */
  sessionAlive: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type NeedsHumanEvent = z.infer<typeof needsHumanEventSchema>;

const ids = { jobId: z.uuid(), runId: z.uuid() };
const step = {
  stepIndex: z.number().int().nonnegative(),
  stepName: z.string().min(1),
};

/** What a step reported, as the step runner records it. */
export const STEP_OUTCOMES = ["next", "done", "needs_human", "impossible"] as const;
export type StepOutcome = (typeof STEP_OUTCOMES)[number];

/**
 * Every event a job writes. Each one is validated against this before it is stored;
 * `status` is the job's status once the event has happened.
 */
export const jobEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("job_started"),
    ...ids,
    status: z.literal("RUNNING"),
    adapterId: z.string().min(1),
    attempt: z.number().int().positive(),
    /** True when the job continues in the tab it was parked in. */
    resumedOnOpenPage: z.boolean(),
  }),
  /** The worker died mid-step; the job goes back to the queue at its checkpoint. */
  z.object({ type: z.literal("recovered_after_restart"), ...ids, status: z.literal("QUEUED") }),
  /** The human asked for another look at a job that was waiting for them. */
  z.object({ type: z.literal("job_continued"), ...ids, status: z.literal("QUEUED") }),
  z.object({ type: z.literal("step_started"), ...ids, ...step, status: z.literal("RUNNING") }),
  z.object({
    type: z.literal("step_finished"),
    ...ids,
    ...step,
    status: z.literal("RUNNING"),
    outcome: z.enum(STEP_OUTCOMES),
    /** Relative to the data dir. Null only when the screenshot could not be taken. */
    screenshotPath: z.string().min(1).nullable(),
  }),
  z.object({
    type: z.literal("adapter_note"),
    ...ids,
    status: z.literal("RUNNING"),
    message: z.string().min(1).max(500),
  }),
  needsHumanEventSchema,
  z.object({
    type: z.literal("job_succeeded"),
    ...ids,
    status: z.literal("SUCCEEDED"),
    download: downloadedFileSchema,
  }),
  z.object({
    type: z.literal("job_manual"),
    ...ids,
    status: z.literal("MANUAL"),
    reason: manualReasonSchema,
    detail: z.string().min(1),
    link: z.url({ protocol: /^https?$/ }),
  }),
  z.object({
    type: z.literal("job_failed"),
    ...ids,
    status: z.literal("FAILED"),
    error: z.string().min(1),
  }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;
