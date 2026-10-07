import { describe, expect, it } from "vitest";
import {
  acceptCode,
  accessStatus,
  effectiveNow,
  findCodeByHash,
  hashCode,
  normaliseCode,
  type AccessInput,
} from "./access.ts";
import { ACCESS_CODES, type AccessCode } from "./build-config.ts";

const TEST_CODE: AccessCode = {
  sha256: hashCode("gatecrusher"),
  expiresAt: "2026-12-07T23:59:59.000Z",
};
const PERMANENT_CODE: AccessCode = { sha256: hashCode("pookiebear"), expiresAt: null };
const CODES = [TEST_CODE, PERMANENT_CODE];
const NOW = new Date("2026-10-07T12:00:00.000Z");
const AFTER_TEST = new Date("2026-12-08T00:00:00.000Z");

function input(overrides: Partial<AccessInput> = {}): AccessInput {
  return {
    now: NOW,
    lastSeenAt: null,
    acceptedCodeHash: TEST_CODE.sha256,
    codes: CODES,
    ...overrides,
  };
}

describe("acceptCode", () => {
  it("ignores surrounding spaces and capitals", () => {
    expect(normaliseCode("  GateCrusher \n")).toBe("gatecrusher");
    expect(acceptCode(" GATECRUSHER ", CODES, NOW)).toBe(TEST_CODE);
    expect(acceptCode("PookieBear", CODES, NOW)).toBe(PERMANENT_CODE);
  });

  it.each(["", "gate crusher", "gatecrusher1", "pookie bear", "letmein"])("rejects %j", (code) => {
    expect(acceptCode(code, CODES, NOW)).toBeNull();
  });

  it("rejects a code past its end date, but not the permanent one", () => {
    expect(acceptCode("gatecrusher", CODES, AFTER_TEST)).toBeNull();
    expect(acceptCode("pookiebear", CODES, AFTER_TEST)).toBe(PERMANENT_CODE);
    expect(acceptCode("pookiebear", CODES, new Date("2099-01-01T00:00:00.000Z"))).toBe(
      PERMANENT_CODE,
    );
  });

  it("rejects everything against malformed hashes", () => {
    expect(acceptCode("gatecrusher", [{ sha256: "", expiresAt: null }], NOW)).toBeNull();
    expect(acceptCode("gatecrusher", [{ sha256: "not-hex", expiresAt: null }], NOW)).toBeNull();
    expect(findCodeByHash("not-hex", CODES)).toBeNull();
    expect(findCodeByHash(null, CODES)).toBeNull();
  });
});

describe("the codes this build ships with", () => {
  it("are the test code until 2026-12-07 and the permanent code", () => {
    expect(ACCESS_CODES).toEqual(CODES);
  });
});

describe("accessStatus", () => {
  it("lets a machine that entered one of this build's codes in", () => {
    expect(accessStatus(input())).toEqual({ kind: "ok" });
    expect(accessStatus(input({ acceptedCodeHash: PERMANENT_CODE.sha256 }))).toEqual({
      kind: "ok",
    });
  });

  it("asks for a code the first time", () => {
    expect(accessStatus(input({ acceptedCodeHash: null }))).toEqual({ kind: "needs_code" });
  });

  it("asks again when a new build no longer has the code this machine entered", () => {
    expect(accessStatus(input({ codes: [PERMANENT_CODE] }))).toEqual({ kind: "needs_code" });
  });

  it("stops after the test code's end date", () => {
    const expired = { kind: "expired", expiredAt: TEST_CODE.expiresAt };
    expect(accessStatus(input({ now: AFTER_TEST }))).toEqual(expired);
    expect(accessStatus(input({ now: new Date("2027-01-01T00:00:00.000Z") }))).toEqual(expired);
  });

  it("never stops a machine on the permanent code", () => {
    expect(
      accessStatus(
        input({
          acceptedCodeHash: PERMANENT_CODE.sha256,
          now: new Date("2099-01-01T00:00:00.000Z"),
        }),
      ),
    ).toEqual({ kind: "ok" });
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
  it("is the clock when nothing later was seen", () => {
    expect(effectiveNow(NOW, null)).toEqual(NOW);
    expect(effectiveNow(NOW, "2026-10-01T00:00:00.000Z")).toEqual(NOW);
    expect(effectiveNow(NOW, "garbage")).toEqual(NOW);
  });

  it("is the latest time seen when the clock is behind it", () => {
    expect(effectiveNow(NOW, "2026-10-09T00:00:00.000Z")).toEqual(
      new Date("2026-10-09T00:00:00.000Z"),
    );
  });
});
