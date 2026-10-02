import {
  adapterStateSchema,
  stepResultSchema,
  type AdapterState,
  type GateAdapter,
  type GateContext,
  type GateResult,
  type StepOutcome,
  type StepResult,
} from "@gatecrusher/core";

export interface StepReport {
  stepIndex: number;
  stepName: string;
  outcome: StepOutcome;
  /** Relative to the data dir. Null only when a non-essential screenshot failed. */
  screenshotPath: string | null;
  /** Set when the step is complete: where to re-enter from, and the state to keep. */
  checkpoint: { stepIndex: number; state: AdapterState } | null;
}

/** How the runner reports. The worker turns these into events and checkpoints. */
export interface RunnerIo {
  stepStarted(step: { stepIndex: number; stepName: string }): Promise<void>;
  stepFinished(report: StepReport): Promise<void>;
}

export interface RunStepsOptions<TPage> {
  adapter: GateAdapter<GateContext<TPage>>;
  ctx: GateContext<TPage>;
  /** The persisted checkpoint when resuming on the same page; 0 on a fresh page. */
  startIndex: number;
  /** True when continuing in a tab that was parked: look for the blocker first. */
  resumedOnOpenPage: boolean;
  io: RunnerIo;
}

export interface RunOutcome {
  result: GateResult;
  /** The step the run ended on. */
  stepIndex: number;
  stepName: string;
  /** The screenshot taken when the run ended. Always set for `needs_human`. */
  screenshotPath: string | null;
  /** The adapter state to persist with the outcome. */
  state: AdapterState;
}

const UNEXPECTED_PAGE_DESCRIPTION =
  "The page did not look as expected. Check the tab in the worker's browser window.";

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Runs one step. A timeout waiting for something the step expected is not a failure:
 * the page is not what the adapter knows, which is the human's to look at. Anything
 * else a step throws is a programmer or infrastructure error and propagates.
 */
async function runStep<TPage>(
  step: GateAdapter<GateContext<TPage>>["steps"][number],
  ctx: GateContext<TPage>,
): Promise<StepResult> {
  try {
    return stepResultSchema.parse(await step.run(ctx));
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    ctx.log.warn({ step: step.name, err: error }, "Step timed out waiting for the page");
    return {
      kind: "needs_human",
      reason: "unexpected_page",
      description: UNEXPECTED_PAGE_DESCRIPTION,
    };
  }
}

/**
 * After every step: is something on the page that only the human can deal with? A
 * blocker outranks whatever the step concluded — a captcha interstitial must never be
 * read as a dead link — except a verified download, and a step's own, more specific
 * request for the human.
 */
async function withBlockerCheck<TPage>(
  result: StepResult,
  ctx: GateContext<TPage>,
): Promise<StepResult> {
  if (result.kind === "done") return result;
  if (result.kind === "needs_human" && result.reason !== "unexpected_page") return result;
  const blocker = await ctx.checkBlockers();
  return blocker === null ? result : { kind: "needs_human", ...blocker };
}

async function screenshotFor<TPage>(
  result: StepResult,
  stepName: string,
  ctx: GateContext<TPage>,
): Promise<string | null> {
  if (result.kind === "needs_human") {
    // The human needs this one to find the tab, so a failure here is a real error.
    return ctx.screenshot(stepName, { maskInputs: result.reason === "login_challenge" });
  }
  try {
    return await ctx.screenshot(stepName);
  } catch (error) {
    ctx.log.warn({ step: stepName, err: error }, "Could not take the step screenshot");
    return null;
  }
}

function snapshotState(state: AdapterState): AdapterState {
  return adapterStateSchema.parse(structuredClone(state));
}

/**
 * The loop every adapter runs through: report the step, run it, check for blockers,
 * take a screenshot, checkpoint, wait, next. Returns as soon as a step ends the run.
 */
export async function runSteps<TPage>(options: RunStepsOptions<TPage>): Promise<RunOutcome> {
  const { adapter, ctx, io } = options;
  const first = adapter.steps[options.startIndex];
  if (first === undefined) {
    throw new Error(`Adapter "${adapter.id}" has no step ${options.startIndex}`);
  }

  if (options.resumedOnOpenPage) {
    // "Continue" only means "look again": if the blocker is still there, park again
    // without touching the page.
    const blocker = await ctx.checkBlockers();
    if (blocker !== null) {
      const result: StepResult = { kind: "needs_human", ...blocker };
      return {
        result: {
          ok: false,
          kind: "needs_human",
          reason: blocker.reason,
          description: blocker.description,
          stepIndex: options.startIndex,
          stepName: first.name,
        },
        stepIndex: options.startIndex,
        stepName: first.name,
        screenshotPath: await screenshotFor(result, first.name, ctx),
        state: snapshotState(ctx.state),
      };
    }
  }

  for (let stepIndex = options.startIndex; stepIndex < adapter.steps.length; stepIndex += 1) {
    const step = adapter.steps[stepIndex];
    if (step === undefined) break;
    await io.stepStarted({ stepIndex, stepName: step.name });

    const result = await withBlockerCheck(await runStep(step, ctx), ctx);
    const screenshotPath = await screenshotFor(result, step.name, ctx);
    const state = snapshotState(ctx.state);
    const report = { stepIndex, stepName: step.name, outcome: result.kind, screenshotPath };
    const ended = { stepIndex, stepName: step.name, screenshotPath, state };

    switch (result.kind) {
      case "next":
        await io.stepFinished({ ...report, checkpoint: { stepIndex: stepIndex + 1, state } });
        await ctx.delay("between-steps");
        break;
      case "done":
        await io.stepFinished({ ...report, checkpoint: null });
        return { ...ended, result: { ok: true, download: result.download } };
      case "needs_human":
        await io.stepFinished({ ...report, checkpoint: null });
        return {
          ...ended,
          result: {
            ok: false,
            kind: "needs_human",
            reason: result.reason,
            description: result.description,
            stepIndex,
            stepName: step.name,
          },
        };
      case "impossible":
        await io.stepFinished({ ...report, checkpoint: null });
        return {
          ...ended,
          result: { ok: false, kind: "impossible", reason: result.reason, detail: result.detail },
        };
    }
  }

  throw new Error(`Adapter "${adapter.id}" ran out of steps without finishing`);
}
