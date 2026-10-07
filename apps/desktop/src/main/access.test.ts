import { describe, expect, it } from "vitest";
import {
  accessStatus,
  effectiveNow,
  hashCode,
  isCorrectCode,
  normaliseCode,
  type AccessInput,
} from "./access.ts";
import { ACCESS_CODE_SHA256, BUILD_EXPIRES_AT } from "./build-config.ts";

const EXPECTED = hashCode("gatecrusher");

function input(overrides: Partial<AccessInput> = {}): AccessInput {
  return {
    now: new Date("2026-10-07T12:00:00.000Z"),
    lastSeenAt: null,
    expiresAt: "2026-12-07T23:59:59.000Z",
    acceptedCodeHash: EXPECTED,
    expectedCodeHash: EXPECTED,
    ...overrides,
  };
}

describe("the access code", () => {
  it("ignores surrounding spaces and capitals", () => {
    expect(normaliseCode("  GateCrusher \n")).toBe("gatecrusher");
    expect(isCorrectCode(" GATECRUSHER ", EXPECTED)).toBe(true);
  });

  it.each(["", "gate crusher", "gatecrusher1", "letmein"])("rejects %j", (code) => {
    expect(isCorrectCode(code, EXPECTED)).toBe(false);
  });

  it("rejects everything against a malformed expected hash", () => {
    expect(isCorrectCode("gatecrusher", "")).toBe(false);
    expect(isCorrectCode("gatecrusher", "not-hex")).toBe(false);
  });

  it("is the one this build ships with", () => {
    expect(ACCESS_CODE_SHA256).toBe(EXPECTED);
    expect(Date.parse(BUILD_EXPIRES_AT)).toBe(Date.parse("2026-12-07T23:59:59.000Z"));
  });
});

describe("accessStatus", () => {
  it("lets a machine that entered this build's code in", () => {
    expect(accessStatus(input())).toEqual({ kind: "ok" });
  });

  it("asks for the code the first time", () => {
    expect(accessStatus(input({ acceptedCodeHash: null }))).toEqual({ kind: "needs_code" });
  });

  it("asks again when a new build has a new code", () => {
    expect(accessStatus(input({ expectedCodeHash: hashCode("next-code") }))).toEqual({
      kind: "needs_code",
    });
  });

  it("stops after the expiry, code or not", () => {
    const expired = { kind: "expired", expiredAt: "2026-12-07T23:59:59.000Z" };
    expect(accessStatus(input({ now: new Date("2026-12-08T00:00:00.000Z") }))).toEqual(expired);
    expect(
      accessStatus(input({ now: new Date("2027-01-01T00:00:00.000Z"), acceptedCodeHash: null })),
    ).toEqual(expired);
  });

  it("still runs on the last second", () => {
    expect(accessStatus(input({ now: new Date("2026-12-07T23:59:59.000Z") }))).toEqual({
      kind: "ok",
    });
  });

  it("is not fooled by winding the clock back", () => {
    const status = accessStatus(
      input({ now: new Date("2026-11-01T00:00:00.000Z"), lastSeenAt: "2026-12-10T00:00:00.000Z" }),
    );

    expect(status.kind).toBe("expired");
  });
});

describe("effectiveNow", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");

  it("is the clock when nothing later was seen", () => {
    expect(effectiveNow(now, null)).toEqual(now);
    expect(effectiveNow(now, "2026-10-01T00:00:00.000Z")).toEqual(now);
    expect(effectiveNow(now, "garbage")).toEqual(now);
  });

  it("is the latest time seen when the clock is behind it", () => {
    expect(effectiveNow(now, "2026-10-09T00:00:00.000Z")).toEqual(
      new Date("2026-10-09T00:00:00.000Z"),
    );
  });
});
