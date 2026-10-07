import type { DelayKind, TrackJobResult } from "@gatecrusher/core";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startJobLoop, type JobLoop, type JobLoopDeps, type TrackOutcome } from "./job-loop.ts";

const POLL_MS = 1_000;

interface FakeOptions {
  interrupted?: string[];
  queued?: string[];
  outcomes?: Record<string, TrackJobResult["outcome"] | "throw">;
  backOff?: Record<string, number>;
  failReads?: number;
}

/** A queue in memory, a clock that only moves when the loop sleeps, and a record of it all. */
function fake(options: FakeOptions = {}) {
  const queued = [...(options.queued ?? [])];
  let clock = 0;
  let failReads = options.failReads ?? 0;
  let active = 0;
  const state = {
    processed: [] as string[],
    crashed: [] as string[],
    delays: [] as DelayKind[],
    sleeps: [] as number[],
    maxActive: 0,
    /** Lets a test hold a job in flight. */
    gate: null as Promise<void> | null,
  };

  const deps: JobLoopDeps = {
    log: pino({ level: "silent" }),
    interruptedJobIds: () => Promise.resolve([...(options.interrupted ?? [])]),
    nextJobId: () => {
      if (failReads > 0) {
        failReads -= 1;
        return Promise.reject(new Error("connection refused"));
      }
      return Promise.resolve(queued.shift() ?? null);
    },
    processTrack: async (jobId): Promise<TrackOutcome> => {
      active += 1;
      state.maxActive = Math.max(state.maxActive, active);
      state.processed.push(jobId);
      try {
        if (state.gate !== null) await state.gate;
        const outcome = options.outcomes?.[jobId] ?? "succeeded";
        if (outcome === "throw") throw new Error("adapter bug");
        const backOffMs = options.backOff?.[jobId];
        return { result: { jobId, outcome }, ...(backOffMs === undefined ? {} : { backOffMs }) };
      } finally {
        active -= 1;
      }
    },
    recordCrash: (jobId) => {
      state.crashed.push(jobId);
      return Promise.resolve();
    },
    delay: {
      wait: (kind) => {
        state.delays.push(kind);
        return Promise.resolve();
      },
    },
    pollIntervalMs: POLL_MS,
    sleep: (ms) => {
      state.sleeps.push(ms);
      clock += ms;
      // A real macrotask, so an idle loop yields to the test.
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
    now: () => clock,
  };
  return { deps, state, enqueue: (...ids: string[]) => queued.push(...ids) };
}

let loop: JobLoop | undefined;

afterEach(async () => {
  await loop?.stop();
  loop = undefined;
});

describe("startJobLoop", () => {
  it("runs interrupted jobs first, then the queue in order, one at a time", async () => {
    const { deps, state } = fake({ interrupted: ["r1"], queued: ["q1", "q2"] });

    loop = startJobLoop(deps);

    await vi.waitFor(() => expect(state.processed).toEqual(["r1", "q1", "q2"]));
    expect(state.maxActive).toBe(1);
  });

  it("pauses between jobs, but not after one that had nothing to do", async () => {
    const { deps, state } = fake({
      queued: ["a", "b", "c"],
      outcomes: { a: "succeeded", b: "skipped", c: "manual" },
    });

    loop = startJobLoop(deps);

    await vi.waitFor(() => expect(state.processed).toHaveLength(3));
    await vi.waitFor(() => expect(state.delays).toEqual(["between-jobs", "between-jobs"]));
  });

  it("waits the poll interval while the queue is empty, then picks up new work", async () => {
    const { deps, state, enqueue } = fake();

    loop = startJobLoop(deps);
    await vi.waitFor(() => expect(state.sleeps.length).toBeGreaterThan(2));
    expect(new Set(state.sleeps)).toEqual(new Set([POLL_MS]));

    enqueue("late");
    await vi.waitFor(() => expect(state.processed).toEqual(["late"]));
  });

  it("takes nothing new until a back-off has passed", async () => {
    const { deps, state } = fake({ queued: ["limited", "next"], backOff: { limited: 600_000 } });

    loop = startJobLoop(deps);

    await vi.waitFor(() => expect(state.processed).toEqual(["limited", "next"]));
    expect(state.sleeps[0]).toBe(600_000);
  });

  it("records a job whose processor threw, and carries on", async () => {
    const { deps, state } = fake({ queued: ["broken", "fine"], outcomes: { broken: "throw" } });

    loop = startJobLoop(deps);

    await vi.waitFor(() => expect(state.processed).toEqual(["broken", "fine"]));
    expect(state.crashed).toEqual(["broken"]);
    await vi.waitFor(() => expect(state.delays).toHaveLength(2));
  });

  it("retries a failed queue read after a longer wait", async () => {
    const { deps, state } = fake({ queued: ["a"], failReads: 1 });

    loop = startJobLoop(deps);

    await vi.waitFor(() => expect(state.processed).toEqual(["a"]));
    expect(state.sleeps[0]).toBe(POLL_MS * 5);
  });

  it("stop() lets the job in flight finish and takes no new one", async () => {
    const { deps, state } = fake({ queued: ["running", "never"] });
    let release = (): void => undefined;
    state.gate = new Promise((resolve) => {
      release = resolve;
    });

    loop = startJobLoop(deps);
    await vi.waitFor(() => expect(state.processed).toEqual(["running"]));

    const stopping = loop.stop();
    release();
    await stopping;
    loop = undefined;

    expect(state.processed).toEqual(["running"]);
  });
});
