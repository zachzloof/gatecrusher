// Whether this copy of the app may run: the person using it has entered one of this
// build's access codes, and that code has not reached its end date. Pure, so it is
// tested without Electron.
//
// This is a soft lock for a private test build: the check runs on the user's machine, so
// someone determined can get around it. It stops casual use after the test period.
import { createHash, timingSafeEqual } from "node:crypto";
import type { AccessCode } from "./build-config.ts";

export type AccessStatus =
  | { kind: "ok" }
  | { kind: "needs_code" }
  | { kind: "expired"; expiredAt: string };

export interface AccessInput {
  /** The machine's clock. */
  now: Date;
  /** The latest time this app has seen on this machine, if any. */
  lastSeenAt: string | null;
  /** Hash of the code this machine entered last, if any. */
  acceptedCodeHash: string | null;
  /** The codes this build accepts. */
  codes: readonly AccessCode[];
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

/** The code with this hash, if this build has one. */
export function findCodeByHash(
  hash: string | null,
  codes: readonly AccessCode[],
): AccessCode | null {
  if (hash === null) return null;
  return codes.find((code) => sameHash(hash, code.sha256)) ?? null;
}

export function hasExpired(code: AccessCode, now: Date): boolean {
  return code.expiresAt !== null && now.getTime() > Date.parse(code.expiresAt);
}

/**
 * The code a typed-in value unlocks, if any: it must be one of this build's codes and
 * must not have reached its end date yet.
 */
export function acceptCode(
  typed: string,
  codes: readonly AccessCode[],
  now: Date,
): AccessCode | null {
  const code = findCodeByHash(hashCode(typed), codes);
  return code === null || hasExpired(code, now) ? null : code;
}

/**
 * The time to judge expiry by: the clock, or the latest time already seen if the clock
 * is behind it, so winding the clock back does not bring an expired code back.
 */
export function effectiveNow(now: Date, lastSeenAt: string | null): Date {
  const seen = lastSeenAt === null ? Number.NaN : Date.parse(lastSeenAt);
  return Number.isFinite(seen) && seen > now.getTime() ? new Date(seen) : now;
}

export function accessStatus(input: AccessInput): AccessStatus {
  const now = effectiveNow(input.now, input.lastSeenAt);
  const code = findCodeByHash(input.acceptedCodeHash, input.codes);
  if (code === null) return { kind: "needs_code" };
  if (code.expiresAt !== null && hasExpired(code, now)) {
    return { kind: "expired", expiredAt: code.expiresAt };
  }
  return { kind: "ok" };
}
