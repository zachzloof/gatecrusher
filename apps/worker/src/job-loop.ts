// The worker's queue loop. The queue is the `jobs` table: the loop takes the next QUEUED
// job, runs it to its resting point, pauses like a human would, and takes the next.
// Hard rule: one job at a time, so there is never more than one in flight.
import type { TrackJobResult } from "@gatecrusher/core";
import type { DelayProvider } from "@gatecrusher/gates";
import type { Logger } from "pino";

export interface TrackOutcome {
  result: TrackJobResult;
  /** Set when the site pushed back: the worker should stop taking jobs for this long. */
  backOffMs?: number;
}

export interface JobLoopDeps {
  log: Logger;
  /** Jobs a dead worker left running. Read once at start and run before anything else. */
  interruptedJobIds(): Promise<string[]>;
  /** The next queued job, or `null` when there is none. */
  nextJobId(): Promise<string | null>;
  /** Runs one track job to its next resting point. */
  processTrack(jobId: string): Promise<TrackOutcome>;
  /** Records a job whose processor threw as FAILED (retryable). */
  recordCrash(jobId: string, error: unknown): Promise<void>;
  delay: DelayProvider;
  /** How long an idle loop waits before looking again. */
  pollIntervalMs: number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface JobLoop {
  /** Takes no new job, then resolves once the job in flight (if any) has finished. */
  stop(): Promise<void>;
}

/** After a failed queue read, wait this many poll intervals before reading again. */
const READ_RETRY_FACTOR = 5;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function startJobLoop(deps: JobLoopDeps): JobLoop {
  const { log } = deps;
  const controller = new AbortController();
  const { signal } = controller;
  const sleep = deps.sleep ?? abortableSleep;
  const now = deps.now ?? (() => Date.now());
  const stopped = new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  let pausedUntil = 0;

  const runOne = async (jobId: string): Promise<void> => {
    let outcome: TrackOutcome | null = null;
    try {
      outcome = await deps.processTrack(jobId);
    } catch (error) {
      // The job boundary: anything thrown is recorded on the job as a retryable failure.
      log.error({ err: error, jobId }, "Track job threw; recording it as failed");
      await deps
        .recordCrash(jobId, error)
        .catch((recordError: unknown) =>
          log.error({ err: recordError, jobId }, "Could not record the failure"),
        );
    }

    if (outcome?.backOffMs !== undefined) {
      log.warn({ backOffMs: outcome.backOffMs }, "The site pushed back; pausing the queue");
      pausedUntil = now() + outcome.backOffMs;
    }
    if (outcome?.result.outcome === "skipped") {
      // Nothing was done, so no human-like pause; but never spin on the same job.
      await sleep(deps.pollIntervalMs, signal);
      return;
    }
    // Hard rule: behave like a slow human. The next track cannot start before this is
    // over; stopping the worker does not wait for it.
    await Promise.race([deps.delay.wait("between-jobs"), stopped]);
  };

  const loop = async (): Promise<void> => {
    let pending: string[] = [];
    try {
      pending = await deps.interruptedJobIds();
    } catch (error) {
      log.warn({ err: error }, "Could not look for interrupted jobs");
    }
    if (pending.length > 0) {
      log.warn({ count: pending.length }, "Running jobs a previous worker left unfinished");
    }

    while (!signal.aborted) {
      const pause = pausedUntil - now();
      if (pause > 0) {
        await sleep(pause, signal);
        continue;
      }

      let jobId: string | null;
      try {
        jobId = pending.shift() ?? (await deps.nextJobId());
      } catch (error) {
        log.warn({ err: error }, "Could not read the queue; trying again shortly");
        await sleep(deps.pollIntervalMs * READ_RETRY_FACTOR, signal);
        continue;
      }
      if (jobId === null) {
        await sleep(deps.pollIntervalMs, signal);
        continue;
      }
      await runOne(jobId);
    }
  };

  const done = loop().catch((error: unknown) => log.fatal({ err: error }, "Job loop crashed"));

  return {
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}
