import { DELAY_KINDS } from "@gatecrusher/core";
import { describe, expect, it } from "vitest";
import { createDelayProvider, DELAY_RANGES, pickDelayMs } from "./delay.ts";

describe("DELAY_RANGES", () => {
  it.each(DELAY_KINDS)("%s is a real range that never reaches zero", (kind) => {
    const range = DELAY_RANGES[kind];

    expect(range.minMs).toBeGreaterThanOrEqual(500);
    expect(range.maxMs).toBeGreaterThan(range.minMs);
  });

  it("waits longest between tracks", () => {
    expect(DELAY_RANGES["between-jobs"].minMs).toBeGreaterThan(DELAY_RANGES.read.maxMs);
  });
});

describe("pickDelayMs", () => {
  it("covers the whole range, both ends included", () => {
    const range = { minMs: 700, maxMs: 2_200 };

    expect(pickDelayMs(range, () => 0)).toBe(700);
    expect(pickDelayMs(range, () => 0.5)).toBe(1_450);
    expect(pickDelayMs(range, () => 0.999_999)).toBe(2_200);
  });
});

describe("createDelayProvider", () => {
  it("sleeps for a randomised time inside the range of the kind asked for", async () => {
    const slept: number[] = [];
    const values = [0, 0.25, 0.75, 0.999];
    const delay = createDelayProvider({
      random: () => values.shift() ?? 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    for (let index = 0; index < 4; index += 1) await delay.wait("action");

    expect(new Set(slept).size).toBe(4);
    for (const ms of slept) {
      expect(ms).toBeGreaterThanOrEqual(DELAY_RANGES.action.minMs);
      expect(ms).toBeLessThanOrEqual(DELAY_RANGES.action.maxMs);
    }
  });

  it("uses the range of each kind", async () => {
    const slept: number[] = [];
    const delay = createDelayProvider({
      random: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    for (const kind of DELAY_KINDS) await delay.wait(kind);

    expect(slept).toEqual(DELAY_KINDS.map((kind) => DELAY_RANGES[kind].minMs));
  });
});
