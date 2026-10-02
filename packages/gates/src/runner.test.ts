import type {
  AdapterState,
  Blocker,
  DelayKind,
  GateAdapter,
  GateContext,
  ScreenshotOptions,
  StepResult,
} from "@gatecrusher/core";
import { describe, expect, it } from "vitest";
import { runSteps, type RunnerIo, type StepReport } from "./runner.ts";

const download = {
  path: "downloads/fixture-crate/Fixture Artist - Fixture Track.mp3",
  sizeBytes: 2_000_000,
  mimeType: "audio/mpeg",
  kind: "audio" as const,
  checksumSha256: "a".repeat(64),
};

class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

interface Recorded {
  ctx: GateContext;
  io: RunnerIo;
  started: string[];
  reports: StepReport[];
  delays: DelayKind[];
  screenshots: Array<{ label: string; options: ScreenshotOptions | undefined }>;
  blockerChecks: number;
}

interface FakeOptions {
  /** Answers for successive `checkBlockers()` calls; `null` once they run out. */
  blockers?: Array<Blocker | null>;
  failScreenshots?: boolean;
  state?: AdapterState;
}

function recorded(options: FakeOptions = {}): Recorded {
  const blockers = [...(options.blockers ?? [])];
  const record: Recorded = {
    started: [],
    reports: [],
    delays: [],
    screenshots: [],
    blockerChecks: 0,
    io: {
      stepStarted: (step) => {
        record.started.push(step.stepName);
        return Promise.resolve();
      },
      stepFinished: (report) => {
        record.reports.push(report);
        return Promise.resolve();
      },
    },
    ctx: {
      page: null,
      track: { id: "t", title: "Fixture Track", artist: "Fixture Artist", permalinkUrl: "x" },
      gateUrl: "https://gate.example/track",
      landmarkTimeoutMs: 10,
      delay: (kind) => {
        record.delays.push(kind);
        return Promise.resolve();
      },
      screenshot: (label, screenshotOptions) => {
        record.screenshots.push({ label, options: screenshotOptions });
        return options.failScreenshots === true
          ? Promise.reject(new Error("page closed"))
          : Promise.resolve(`screenshots/run/job/${record.screenshots.length}-${label}.png`);
      },
      emit: () => Promise.resolve(),
      checkBlockers: () => {
        record.blockerChecks += 1;
        return Promise.resolve(blockers.shift() ?? null);
      },
      waitForDownload: () => Promise.reject(new Error("not used")),
      state: options.state ?? {},
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    },
  };
  return record;
}

type Step = (ctx: GateContext) => Promise<StepResult> | StepResult;

function adapterOf(steps: Record<string, Step>): GateAdapter<GateContext> {
  return {
    id: "fake-gate",
    priority: 1,
    detect: () => true,
    steps: Object.entries(steps).map(([name, run]) => ({
      name,
      run: (ctx) => Promise.resolve(run(ctx)),
    })),
  };
}

const next = (): StepResult => ({ kind: "next" });
const done = (): StepResult => ({ kind: "done", download });
const captcha: Blocker = { reason: "captcha", description: "Solve the captcha." };

function run(adapter: GateAdapter<GateContext>, record: Recorded, startIndex = 0, resumed = false) {
  return runSteps({
    adapter,
    ctx: record.ctx,
    startIndex,
    resumedOnOpenPage: resumed,
    io: record.io,
  });
}

describe("runSteps", () => {
  it("runs every step in order and finishes with the download", async () => {
    const record = recorded();
    const outcome = await run(adapterOf({ open: next, unlock: next, download: done }), record);

    expect(outcome.result).toEqual({ ok: true, download });
    expect(outcome).toMatchObject({ stepIndex: 2, stepName: "download" });
    expect(record.started).toEqual(["open", "unlock", "download"]);
    expect(record.reports.map((report) => [report.stepName, report.outcome])).toEqual([
      ["open", "next"],
      ["unlock", "next"],
      ["download", "done"],
    ]);
  });

  it("checkpoints the next step index and the adapter state after each completed step", async () => {
    const record = recorded();
    const adapter = adapterOf({
      open: (ctx) => {
        ctx.state.gateId = "abc";
        return next();
      },
      unlock: (ctx) => {
        ctx.state.unlocked = true;
        return next();
      },
      download: done,
    });

    await run(adapter, record);

    expect(record.reports.map((report) => report.checkpoint)).toEqual([
      { stepIndex: 1, state: { gateId: "abc" } },
      { stepIndex: 2, state: { gateId: "abc", unlocked: true } },
      null,
    ]);
  });

  it("takes a screenshot after every step and reports its path", async () => {
    const record = recorded();
    await run(adapterOf({ open: next, download: done }), record);

    expect(record.screenshots.map((shot) => shot.label)).toEqual(["open", "download"]);
    expect(record.reports.map((report) => report.screenshotPath)).toEqual([
      "screenshots/run/job/1-open.png",
      "screenshots/run/job/2-download.png",
    ]);
  });

  it("waits between steps, and only between steps", async () => {
    const record = recorded();
    await run(adapterOf({ open: next, unlock: next, download: done }), record);

    expect(record.delays).toEqual(["between-steps", "between-steps"]);
  });

  it("checks for blockers after every step that did not finish the run", async () => {
    const record = recorded();
    await run(adapterOf({ open: next, unlock: next, download: done }), record);

    expect(record.blockerChecks).toBe(2);
  });

  it("parks at the step a blocker appears after, without advancing the checkpoint", async () => {
    const record = recorded({ blockers: [null, captcha] });
    const outcome = await run(adapterOf({ open: next, unlock: next, download: done }), record);

    expect(outcome.result).toEqual({
      ok: false,
      kind: "needs_human",
      reason: "captcha",
      description: "Solve the captcha.",
      stepIndex: 1,
      stepName: "unlock",
    });
    expect(outcome.screenshotPath).toBe("screenshots/run/job/2-unlock.png");
    expect(record.started).toEqual(["open", "unlock"]);
    expect(record.reports.at(-1)).toMatchObject({ outcome: "needs_human", checkpoint: null });
  });

  it("never lets a blocker be read as impossible", async () => {
    const record = recorded({ blockers: [captcha] });
    const adapter = adapterOf({
      open: () => ({ kind: "impossible", reason: "dead_link", detail: "404" }),
    });

    const outcome = await run(adapter, record);

    expect(outcome.result).toMatchObject({ ok: false, kind: "needs_human", reason: "captcha" });
  });

  it("reports impossible when the page really has nothing for the human", async () => {
    const record = recorded();
    const adapter = adapterOf({
      open: () => ({ kind: "impossible", reason: "file_gone", detail: "No longer offered" }),
    });

    const outcome = await run(adapter, record);

    expect(outcome.result).toEqual({
      ok: false,
      kind: "impossible",
      reason: "file_gone",
      detail: "No longer offered",
    });
  });

  it("turns a timeout on an expected element into needs_human, not a failure", async () => {
    const record = recorded();
    const adapter = adapterOf({
      open: () => Promise.reject(new TimeoutError("locator.click: Timeout 10ms exceeded")),
    });

    const outcome = await run(adapter, record);

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "unexpected_page",
      stepIndex: 0,
    });
  });

  it("names the real blocker when a step only saw an unexpected page", async () => {
    const record = recorded({ blockers: [captcha] });
    const adapter = adapterOf({
      open: () => ({ kind: "needs_human", reason: "unexpected_page", description: "Odd page." }),
    });

    expect((await run(adapter, record)).result).toMatchObject({ reason: "captcha" });
  });

  it("keeps a step's own, specific request for the human", async () => {
    const record = recorded({ blockers: [captcha] });
    const adapter = adapterOf({
      open: () => ({ kind: "needs_human", reason: "login_challenge", description: "Sign in." }),
    });

    const outcome = await run(adapter, record);

    expect(outcome.result).toMatchObject({ reason: "login_challenge", description: "Sign in." });
    expect(record.blockerChecks).toBe(0);
  });

  it("masks inputs in the screenshot of a login challenge", async () => {
    const record = recorded();
    const adapter = adapterOf({
      open: () => ({ kind: "needs_human", reason: "login_challenge", description: "Sign in." }),
    });

    await run(adapter, record);

    expect(record.screenshots).toEqual([{ label: "open", options: { maskInputs: true } }]);
  });

  it("propagates anything else a step throws: that is a programmer error", async () => {
    const adapter = adapterOf({ open: () => Promise.reject(new Error("boom")) });

    await expect(run(adapter, recorded())).rejects.toThrow("boom");
  });

  it("rejects a step result that is not one of the four kinds", async () => {
    const adapter = adapterOf({ open: () => ({ kind: "failed" }) as unknown as StepResult });

    await expect(run(adapter, recorded())).rejects.toThrow();
  });

  it("carries on without a screenshot when an ordinary step's screenshot fails", async () => {
    const record = recorded({ failScreenshots: true });
    const outcome = await run(adapterOf({ open: next, download: done }), record);

    expect(outcome.result.ok).toBe(true);
    expect(record.reports.map((report) => report.screenshotPath)).toEqual([null, null]);
  });

  it("does not park without a screenshot: that failure is real", async () => {
    const record = recorded({ failScreenshots: true, blockers: [captcha] });

    await expect(run(adapterOf({ open: next, download: done }), record)).rejects.toThrow(
      "page closed",
    );
  });

  it("starts from the checkpoint and does not re-run earlier steps", async () => {
    const record = recorded({ state: { gateId: "abc" } });
    const outcome = await run(adapterOf({ open: next, unlock: next, download: done }), record, 1);

    expect(record.started).toEqual(["unlock", "download"]);
    expect(outcome.state).toEqual({ gateId: "abc" });
  });

  it("on resume, parks again without running the step while the blocker is still there", async () => {
    const record = recorded({ blockers: [captcha] });
    const outcome = await run(
      adapterOf({ open: next, unlock: next, download: done }),
      record,
      1,
      true,
    );

    expect(outcome.result).toMatchObject({
      ok: false,
      kind: "needs_human",
      reason: "captcha",
      stepIndex: 1,
      stepName: "unlock",
    });
    expect(outcome.screenshotPath).not.toBeNull();
    expect(record.started).toEqual([]);
  });

  it("on resume with the blocker gone, re-enters the same step", async () => {
    const record = recorded({ blockers: [null] });
    const outcome = await run(
      adapterOf({ open: next, unlock: next, download: done }),
      record,
      1,
      true,
    );

    expect(outcome.result.ok).toBe(true);
    expect(record.started).toEqual(["unlock", "download"]);
  });

  it("refuses a start index the adapter does not have", async () => {
    await expect(run(adapterOf({ open: done }), recorded(), 3)).rejects.toThrow("no step 3");
  });

  it("treats running out of steps without a download as a programmer error", async () => {
    await expect(run(adapterOf({ open: next }), recorded())).rejects.toThrow("ran out of steps");
  });
});
