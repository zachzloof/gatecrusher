// Runs an adapter's steps against fixture pages exactly as the worker does — real
// context, real step runner, real download store and verification — with a headless
// browser, no delays, and everything written under a throwaway data dir.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterState, DelayKind, GateLog } from "@gatecrusher/core";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createGateContext, type BrowserGateAdapter } from "../context.ts";
import type { DelayProvider } from "../delay.ts";
import { createDownloadCapture } from "../downloads/store.ts";
import { runSteps, type RunOutcome, type StepReport } from "../runner.ts";
import { createScreenshotter } from "../screenshots.ts";
import { guardNetwork, type NetworkGuard } from "./fixture-server.ts";

export interface RecordingDelay extends DelayProvider {
  /** Every wait that was asked for, in order. None of them took any time. */
  readonly calls: DelayKind[];
}

/** The zero-delay fake: records what was asked for and returns immediately. */
export function createZeroDelay(): RecordingDelay {
  const calls: DelayKind[] = [];
  return {
    calls,
    wait: (kind) => {
      calls.push(kind);
      return Promise.resolve();
    },
  };
}

export const silentLog: GateLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export const HARNESS_RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const HARNESS_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export interface HarnessRunOptions {
  adapter: BrowserGateAdapter;
  page: Page;
  gateUrl: string;
  startIndex?: number;
  resumedOnOpenPage?: boolean;
  state?: AdapterState;
}

export interface HarnessRun {
  outcome: RunOutcome;
  /** Names of the steps that were started, in order. */
  started: string[];
  reports: StepReport[];
  delays: DelayKind[];
  notes: string[];
}

export interface AdapterHarness {
  context: BrowserContext;
  guard: NetworkGuard;
  /** Absolute path of the throwaway data dir. */
  dataDir: string;
  newPage(): Promise<Page>;
  run(options: HarnessRunOptions): Promise<HarnessRun>;
  close(): Promise<void>;
}

export interface AdapterHarnessOptions {
  minBytes?: number;
  landmarkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

export async function createAdapterHarness(
  options: AdapterHarnessOptions = {},
): Promise<AdapterHarness> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "gatecrusher-gates-"));
  // Headless is for tests against local fixtures only; the worker never runs this way.
  const browser: Browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const guard = await guardNetwork(context);

  return {
    context,
    guard,
    dataDir,
    newPage: () => context.newPage(),
    run: async (run) => {
      const delay = createZeroDelay();
      const started: string[] = [];
      const reports: StepReport[] = [];
      const notes: string[] = [];

      const ctx = createGateContext({
        page: run.page,
        track: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          title: "Fixture Track",
          artist: "Fixture Artist",
          permalinkUrl: run.gateUrl,
        },
        gateUrl: run.gateUrl,
        allowedHosts: run.adapter.allowedHosts,
        delay,
        screenshots: createScreenshotter({ dataDir, runId: HARNESS_RUN_ID, jobId: HARNESS_JOB_ID }),
        downloads: createDownloadCapture({
          dataDir,
          minBytes: options.minBytes ?? 1_048_576,
          target: {
            playlistSlug: "fixture-crate",
            artist: "Fixture Artist",
            title: "Fixture Track",
          },
        }),
        state: run.state ?? {},
        log: silentLog,
        emit: (note) => {
          notes.push(note.message);
          return Promise.resolve();
        },
        landmarkTimeoutMs: options.landmarkTimeoutMs ?? 750,
        downloadTimeoutMs: options.downloadTimeoutMs ?? 1_500,
      });

      const outcome = await runSteps({
        adapter: run.adapter,
        ctx,
        startIndex: run.startIndex ?? 0,
        resumedOnOpenPage: run.resumedOnOpenPage ?? false,
        io: {
          stepStarted: (step) => {
            started.push(step.stepName);
            return Promise.resolve();
          },
          stepFinished: (report) => {
            reports.push(report);
            return Promise.resolve();
          },
        },
      });
      return { outcome, started, reports, delays: delay.calls, notes };
    },
    close: async () => {
      await context.close();
      await browser.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
