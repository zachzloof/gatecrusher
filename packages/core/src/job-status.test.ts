import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  JOB_TRANSITION_EVENTS,
  transition,
  type JobStatus,
  type JobTransitionEvent,
} from "./job-status.ts";

/** Every legal transition, written out independently of the implementation's table. */
const LEGAL: ReadonlyArray<readonly [JobStatus, JobTransitionEvent, JobStatus]> = [
  ["QUEUED", "start", "RUNNING"],
  ["QUEUED", "cancel", "CANCELLED"],
  ["RUNNING", "succeed", "SUCCEEDED"],
  ["RUNNING", "needs_human", "WAITING_FOR_HUMAN"],
  ["RUNNING", "impossible", "MANUAL"],
  ["RUNNING", "fail", "FAILED"],
  ["RUNNING", "recover", "QUEUED"],
  ["WAITING_FOR_HUMAN", "continue", "QUEUED"],
  ["WAITING_FOR_HUMAN", "give_up", "MANUAL"],
  ["FAILED", "retry", "QUEUED"],
];

const expected = new Map(LEGAL.map(([from, event, to]) => [`${from}:${event}`, to]));

const allPairs = JOB_STATUSES.flatMap((from) =>
  JOB_TRANSITION_EVENTS.map((event) => [from, event] as const),
);

describe("transition", () => {
  it("covers every state x event pair", () => {
    expect(allPairs).toHaveLength(JOB_STATUSES.length * JOB_TRANSITION_EVENTS.length);
  });

  it.each(allPairs)("%s + %s", (from, event) => {
    const result = transition(from, event);
    const to = expected.get(`${from}:${event}`);

    if (to === undefined) {
      expect(result).toEqual({
        ok: false,
        kind: "illegal_transition",
        reason: `A ${from} job cannot handle "${event}"`,
      });
    } else {
      expect(result).toEqual({ ok: true, status: to });
    }
  });

  it("never lets a human-blocker end in FAILED or MANUAL directly", () => {
    expect(transition("RUNNING", "needs_human")).toEqual({
      ok: true,
      status: "WAITING_FOR_HUMAN",
    });
    expect(transition("WAITING_FOR_HUMAN", "fail").ok).toBe(false);
    expect(transition("WAITING_FOR_HUMAN", "impossible").ok).toBe(false);
  });

  it("treats SUCCEEDED, MANUAL and CANCELLED as terminal", () => {
    for (const event of JOB_TRANSITION_EVENTS) {
      expect(transition("SUCCEEDED", event).ok).toBe(false);
      expect(transition("MANUAL", event).ok).toBe(false);
      expect(transition("CANCELLED", event).ok).toBe(false);
    }
  });

  it("cancels only a job that has not started: a running track is left to finish", () => {
    expect(transition("RUNNING", "cancel").ok).toBe(false);
    expect(transition("WAITING_FOR_HUMAN", "cancel").ok).toBe(false);
  });
});
