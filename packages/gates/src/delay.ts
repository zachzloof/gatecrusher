import type { DelayKind } from "@gatecrusher/core";

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

/**
 * The one place pacing is configured. Hard rule: behave like a slow human, so every
 * range is randomised and none may start at zero.
 */
export const DELAY_RANGES: Readonly<Record<DelayKind, DelayRange>> = {
  /** Before a click or a keystroke. */
  action: { minMs: 700, maxMs: 2_200 },
  /** After a navigation: time to "read" the page. */
  read: { minMs: 1_500, maxMs: 4_500 },
  /** Applied by the step runner between two steps. */
  "between-steps": { minMs: 800, maxMs: 2_500 },
  /** Applied by the worker between two tracks. */
  "between-jobs": { minMs: 8_000, maxMs: 20_000 },
};

/** Adapters and the worker can only wait through one of these. */
export interface DelayProvider {
  wait(kind: DelayKind): Promise<void>;
}

export interface DelayProviderOptions {
  ranges?: Readonly<Record<DelayKind, DelayRange>>;
  /** Returns a number in [0, 1). */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A whole number of milliseconds within the range, both ends included. */
export function pickDelayMs(range: DelayRange, random: () => number): number {
  return Math.floor(range.minMs + random() * (range.maxMs - range.minMs + 1));
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDelayProvider(options: DelayProviderOptions = {}): DelayProvider {
  const ranges = options.ranges ?? DELAY_RANGES;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? sleepFor;
  return {
    wait: (kind) => sleep(pickDelayMs(ranges[kind], random)),
  };
}
