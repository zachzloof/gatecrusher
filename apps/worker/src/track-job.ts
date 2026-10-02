// One browser job: run (or resume) the adapter for one row of the `jobs` table.
import { adapterStateSchema, playlistSlug, type TrackJobResult } from "@gatecrusher/core";
import {
  completeJob,
  getJobContext,
  markJobFailed,
  markJobManual,
  parkJob,
  recordAdapterNote,
  recordStepFinished,
  recordStepStarted,
  refreshRun,
  startJob,
  type Database,
  type JobContext,
} from "@gatecrusher/db";
import {
  createDownloadCapture,
  createGateContext,
  createScreenshotter,
  runSteps,
  type AdapterRegistry,
  type BrowserGateAdapter,
  type DelayProvider,
  type RunOutcome,
} from "@gatecrusher/gates";
import type { Logger } from "pino";
import type { Page } from "playwright";
import type { BrowserSession } from "./browser.ts";
import type { ParkedPages } from "./parked-pages.ts";

export interface TrackJobDeps {
  db: Database;
  log: Logger;
  browser: BrowserSession;
  parked: ParkedPages;
  registry: AdapterRegistry<BrowserGateAdapter>;
  delay: DelayProvider;
  /** Absolute path of the data dir. */
  dataDir: string;
  minDownloadBytes: number;
  landmarkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpUrl(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const { protocol } = new URL(value);
  return protocol === "https:" || protocol === "http:" ? value : null;
}

/** Where the adapter starts: the track page for a native download, else the gate link. */
function gateUrlOf({ track }: JobContext): string | null {
  const link = track.classification === "native" ? track.permalinkUrl : track.purchaseUrl;
  return link === null ? null : httpUrl(link);
}

async function closeTab(page: Page | undefined, log: Logger): Promise<void> {
  if (page === undefined || page.isClosed()) return;
  try {
    await page.close();
  } catch (error) {
    // The browser went away under us; there is no tab left to close.
    log.debug({ err: error }, "Could not close the job's tab");
  }
}

/**
 * Runs a job to its next resting point: a verified download, a pause for the human, a
 * genuinely-impossible verdict, or a failure. A pause returns just like the others —
 * the tab is parked and the queue slot is free for the next job.
 *
 * Anything thrown while the job runs is caught here, the job boundary, and recorded as
 * FAILED (retryable).
 */
export async function processTrackJob(jobId: string, deps: TrackJobDeps): Promise<TrackJobResult> {
  const found = await getJobContext(deps.db, jobId);
  if (found === null) throw new Error(`Track job ${jobId} does not exist`);
  const { job, track, playlist } = found;
  const log = deps.log.child({ jobId, runId: job.runId, trackId: track.id });

  if (job.status !== "QUEUED" && job.status !== "RUNNING") {
    log.info({ status: job.status }, "Job is not runnable any more, skipping");
    return { jobId, outcome: "skipped" };
  }

  const gateUrl = gateUrlOf(found);
  const adapter = gateUrl === null ? null : deps.registry.resolve(new URL(gateUrl));
  const resumedOnOpenPage = deps.parked.has(jobId);

  const started = await startJob(deps.db, {
    jobId,
    adapterId: adapter?.id ?? "unresolved",
    resumedOnOpenPage,
  });
  if (!started.ok) {
    log.warn({ kind: started.kind, reason: started.reason }, "Job could not be started, skipping");
    return { jobId, outcome: "skipped" };
  }
  if (started.recovered) log.warn("Job was interrupted by a worker restart; running it again");

  let page: Page | undefined;
  try {
    if (gateUrl === null || adapter === null) {
      throw new Error("No adapter can handle this track's link");
    }
    const stepLog = log.child({ adapterId: adapter.id });
    page = deps.parked.take(jobId) ?? (await deps.browser.newPage());
    const ids = { jobId, runId: job.runId };

    const ctx = createGateContext({
      page,
      track: {
        id: track.id,
        title: track.title,
        artist: track.artist,
        permalinkUrl: track.permalinkUrl,
      },
      gateUrl,
      allowedHosts: adapter.allowedHosts,
      delay: deps.delay,
      screenshots: createScreenshotter({ dataDir: deps.dataDir, ...ids }),
      downloads: createDownloadCapture({
        dataDir: deps.dataDir,
        minBytes: deps.minDownloadBytes,
        target: {
          playlistSlug: playlistSlug(playlist.soundcloudUrl, playlist.title),
          artist: track.artist,
          title: track.title,
        },
      }),
      state: adapterStateSchema.parse(job.state),
      log: stepLog,
      emit: (note) => recordAdapterNote(deps.db, { ...ids, message: note.message }),
      ...(deps.landmarkTimeoutMs === undefined
        ? {}
        : { landmarkTimeoutMs: deps.landmarkTimeoutMs }),
      ...(deps.downloadTimeoutMs === undefined
        ? {}
        : { downloadTimeoutMs: deps.downloadTimeoutMs }),
    });

    const outcome = await runSteps({
      adapter,
      ctx,
      // In the tab the job was parked in, carry on at the checkpoint. In a new tab,
      // start over: steps skip themselves when their goal is already met.
      startIndex: resumedOnOpenPage ? job.stepIndex : 0,
      resumedOnOpenPage,
      io: {
        stepStarted: async (step) => {
          stepLog.info({ step: step.stepName }, "Step started");
          await recordStepStarted(deps.db, { ...ids, ...step });
        },
        stepFinished: async (report) => {
          stepLog.info({ step: report.stepName, outcome: report.outcome }, "Step finished");
          await recordStepFinished(deps.db, { ...ids, ...report });
        },
      },
    });

    return await settle(
      outcome,
      { jobId, page, gateUrl, adapterId: adapter.id, log: stepLog },
      deps,
    );
  } catch (error) {
    log.error({ err: error }, "Track job failed");
    const failed = await markJobFailed(deps.db, { jobId, error: errorMessage(error) });
    if (!failed.ok)
      log.error({ kind: failed.kind, reason: failed.reason }, "Could not record the failure");
    await closeTab(page, log);
    return { jobId, outcome: "failed" };
  } finally {
    await refreshRun(deps.db, job.runId);
  }
}

interface Settling {
  jobId: string;
  page: Page;
  gateUrl: string;
  adapterId: string;
  log: Logger;
}

/** Records how the run ended. A recording that is refused is a programmer error. */
async function settle(
  outcome: RunOutcome,
  { jobId, page, gateUrl, adapterId, log }: Settling,
  deps: TrackJobDeps,
): Promise<TrackJobResult> {
  const { result } = outcome;

  if (result.ok) {
    const completed = await completeJob(deps.db, { jobId, download: result.download });
    if (!completed.ok) throw new Error(completed.reason);
    log.info(
      { file: result.download.path, sizeBytes: result.download.sizeBytes },
      "Download verified",
    );
    await closeTab(page, log);
    return { jobId, outcome: "succeeded" };
  }

  if (result.kind === "impossible") {
    const marked = await markJobManual(deps.db, {
      jobId,
      reason: result.reason,
      detail: result.detail,
      link: gateUrl,
    });
    if (!marked.ok) throw new Error(marked.reason);
    log.info({ reason: result.reason }, "Track is not obtainable; marked manual");
    await closeTab(page, log);
    return { jobId, outcome: "manual" };
  }

  if (outcome.screenshotPath === null) {
    throw new Error("The step runner parked a job without a screenshot");
  }
  const parked = await parkJob(deps.db, {
    jobId,
    adapterId,
    stepIndex: result.stepIndex,
    stepName: result.stepName,
    state: outcome.state,
    reason: result.reason,
    description: result.description,
    screenshotPath: outcome.screenshotPath,
    // Chromium's error and blank pages have no http(s) address; the gate link stands in.
    pageUrl: httpUrl(page.url()) ?? gateUrl,
  });
  if (!parked.ok) throw new Error(parked.reason);

  // From here the tab belongs to the human: it stays open and is not touched again
  // until the job is resumed.
  deps.parked.park(jobId, page);
  try {
    await page.bringToFront();
  } catch (error) {
    log.debug({ err: error }, "Could not bring the parked tab to the front");
  }
  log.info(
    { reason: result.reason, step: result.stepName, attempt: parked.attempt },
    "Job is waiting for the human; tab left open",
  );
  return { jobId, outcome: "parked" };
}
