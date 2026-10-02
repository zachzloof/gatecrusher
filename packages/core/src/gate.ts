import { z } from "zod";
import {
  downloadKindSchema,
  humanReasonSchema,
  manualReasonSchema,
  type HumanReason,
} from "./domain.ts";

/** A download that has passed verification (exists, big enough, sniffed as audio/zip). */
export const downloadedFileSchema = z.object({
  /** Relative to the data dir, with forward slashes. */
  path: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  mimeType: z.string().min(1),
  kind: downloadKindSchema,
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DownloadedFile = z.infer<typeof downloadedFileSchema>;

/** Instruction shown to the human on a Needs-you card: one short sentence. */
export const humanDescriptionSchema = z.string().min(1).max(280);

/** What a single step reports back to the step runner. */
export const stepResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("next") }),
  z.object({ kind: z.literal("done"), download: downloadedFileSchema }),
  z.object({
    kind: z.literal("needs_human"),
    reason: humanReasonSchema,
    description: humanDescriptionSchema,
  }),
  z.object({
    kind: z.literal("impossible"),
    reason: manualReasonSchema,
    detail: z.string().min(1),
  }),
]);
export type StepResult = z.infer<typeof stepResultSchema>;

/**
 * The outcome of running an adapter's steps. Adapters report expected outcomes as
 * values; throwing is reserved for programmer errors.
 */
export const gateResultSchema = z.union([
  z.object({ ok: z.literal(true), download: downloadedFileSchema }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("needs_human"),
    reason: humanReasonSchema,
    description: humanDescriptionSchema,
    stepIndex: z.number().int().nonnegative(),
    stepName: z.string().min(1),
  }),
  z.object({
    ok: z.literal(false),
    kind: z.literal("impossible"),
    reason: manualReasonSchema,
    detail: z.string().min(1),
  }),
]);
export type GateResult = z.infer<typeof gateResultSchema>;

/**
 * One resumable unit of an adapter. `name` is stored in the database, so it is a
 * stable identifier — never rename one casually.
 */
export interface GateStep<TContext = unknown> {
  readonly name: string;
  run(ctx: TContext): Promise<StepResult>;
}

/**
 * Every gate implements this, including the AI browser agent (lowest priority).
 * `TContext` is the `GateContext` handed to steps.
 */
export interface GateAdapter<TContext = unknown> {
  readonly id: string;
  /** Higher runs first. */
  readonly priority: number;
  /** Pure and synchronous: no network. */
  detect(url: URL): boolean;
  /**
   * Hosts the adapter expects to stay on (subdomains included). Ending up anywhere else
   * is an unexpected page. Leave out for an adapter that may go anywhere.
   */
  readonly allowedHosts?: readonly string[];
  /** Ordered; each one safe to re-enter after a pause or a worker restart. */
  readonly steps: ReadonlyArray<GateStep<TContext>>;
}

/** What a wait is for. The ranges live in the central delay provider in `gates`. */
export const DELAY_KINDS = ["action", "read", "between-steps", "between-jobs"] as const;
export type DelayKind = (typeof DELAY_KINDS)[number];

/** The adapter's small serialisable bag, persisted between steps. */
export const adapterStateSchema = z.record(z.string(), z.json());
export type AdapterState = z.infer<typeof adapterStateSchema>;

/** Something on the page only the human can deal with. */
export interface Blocker {
  reason: HumanReason;
  /** Instruction to the user. */
  description: string;
}

/** The outcome of triggering a download: only a verified file counts. */
export type DownloadAttempt =
  | { ok: true; download: DownloadedFile }
  | { ok: false; kind: "no_download" | "verification_failed"; reason: string };

/** The track a job is for, as adapters see it. */
export interface GateTrack {
  id: string;
  title: string;
  artist: string;
  permalinkUrl: string;
}

/** The slice of a pino logger adapters use: objects, not interpolated strings. */
export interface GateLog {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface ScreenshotOptions {
  /** Cover every input on the page, for pages where the human types credentials. */
  maskInputs?: boolean;
}

/**
 * Everything a step may use. Adapters never touch the database, the queue or the
 * filesystem directly: they act on `page` and report through this.
 *
 * `TPage` is the browser page type (Playwright's `Page` in `gates`); it is a parameter
 * so that `core` depends on nothing.
 */
export interface GateContext<TPage = unknown> {
  readonly page: TPage;
  readonly track: GateTrack;
  /** Where the adapter starts: the gate link, or the track page for native downloads. */
  readonly gateUrl: string;
  /** How long to wait for an element a step expects before calling the page unexpected. */
  readonly landmarkTimeoutMs: number;
  /** The only way to wait. Call it before every click or keystroke. */
  delay(kind: DelayKind): Promise<void>;
  /** Saves a screenshot and returns its path relative to the data dir. */
  screenshot(label: string, options?: ScreenshotOptions): Promise<string>;
  /** Records a note in the job's event log. */
  emit(note: { message: string }): Promise<void>;
  /** Looks for a captcha, login challenge, email confirmation or foreign page. Read-only. */
  checkBlockers(): Promise<Blocker | null>;
  /** Runs `trigger`, captures the download it starts, stores and verifies it. */
  waitForDownload(trigger: () => Promise<void>): Promise<DownloadAttempt>;
  /** Mutable; persisted with the checkpoint after every step. */
  readonly state: AdapterState;
  readonly log: GateLog;
}

const identifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "must be lower-kebab-case");

const functionSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
  "must be a function",
);

/** Runtime check of an adapter's shape, used when adapters are registered. */
export const gateAdapterSchema = z.object({
  id: identifierSchema,
  priority: z.number().int(),
  detect: functionSchema,
  allowedHosts: z.array(z.string().min(1)).min(1).optional(),
  steps: z
    .array(z.object({ name: identifierSchema, run: functionSchema }))
    .min(1)
    .refine((steps) => new Set(steps.map((step) => step.name)).size === steps.length, {
      error: "step names must be unique within an adapter",
    }),
});

export type GateAdapterValidation =
  { ok: true } | { ok: false; kind: "invalid_adapter"; reason: string };

export function validateGateAdapter(adapter: GateAdapter<never>): GateAdapterValidation {
  const parsed = gateAdapterSchema.safeParse(adapter);
  if (parsed.success) return { ok: true };
  return { ok: false, kind: "invalid_adapter", reason: z.prettifyError(parsed.error) };
}
