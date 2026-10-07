// Whether this copy of the app may run: the build has not expired, and the person using
// it has entered the access code for this build. Pure, so it is tested without Electron.
//
// This is a soft lock for a private test build: the check runs on the user's machine, so
// someone determined can get around it. It stops casual use after the test period.
import { createHash, timingSafeEqual } from "node:crypto";

export type AccessStatus =
  { kind: "ok" } | { kind: "needs_code" } | { kind: "expired"; expiredAt: string };

export interface AccessInput {
  /** The machine's clock. */
  now: Date;
  /** The latest time this app has seen on this machine, if any. */
  lastSeenAt: string | null;
  expiresAt: string;
  /** Hash of the code this machine entered last, if any. */
  acceptedCodeHash: string | null;
  expectedCodeHash: string;
}

/** What is compared: surrounding spaces and capitals do not matter. */
export function normaliseCode(code: string): string {
  return code.trim().toLowerCase();
}

export function hashCode(code: string): string {
  return createHash("sha256").update(normaliseCode(code), "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function isCorrectCode(code: string, expectedCodeHash: string): boolean {
  return sameHash(hashCode(code), expectedCodeHash);
}

/**
 * The time to judge expiry by: the clock, or the latest time already seen if the clock
 * is behind it, so winding the clock back does not bring an expired build back.
 */
export function effectiveNow(now: Date, lastSeenAt: string | null): Date {
  const seen = lastSeenAt === null ? Number.NaN : Date.parse(lastSeenAt);
  return Number.isFinite(seen) && seen > now.getTime() ? new Date(seen) : now;
}

export function accessStatus(input: AccessInput): AccessStatus {
  const now = effectiveNow(input.now, input.lastSeenAt);
  if (now.getTime() > Date.parse(input.expiresAt)) {
    return { kind: "expired", expiredAt: input.expiresAt };
  }
  if (
    input.acceptedCodeHash === null ||
    !sameHash(input.acceptedCodeHash, input.expectedCodeHash)
  ) {
    return { kind: "needs_code" };
  }
  return { kind: "ok" };
}
