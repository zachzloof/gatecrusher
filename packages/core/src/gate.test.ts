import { describe, expect, it } from "vitest";
import {
  gateResultSchema,
  stepResultSchema,
  validateGateAdapter,
  type GateAdapter,
  type StepResult,
} from "./gate.ts";

const download = {
  path: "downloads/seed/artist - title.mp3",
  sizeBytes: 2_000_000,
  mimeType: "audio/mpeg",
  kind: "audio",
  checksumSha256: "a".repeat(64),
};

describe("stepResultSchema", () => {
  it.each([
    { kind: "next" },
    { kind: "done", download },
    { kind: "needs_human", reason: "captcha", description: "Solve the captcha, then Continue." },
    { kind: "impossible", reason: "dead_link", detail: "Gate returned 404" },
  ])("accepts $kind", (value) => {
    expect(stepResultSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["unknown kind", { kind: "skip" }],
    ["done without a download", { kind: "done" }],
    ["done with an empty file", { kind: "done", download: { ...download, sizeBytes: 0 } }],
    [
      "needs_human with a manual reason",
      { kind: "needs_human", reason: "dead_link", description: "x" },
    ],
    [
      "needs_human without an instruction",
      { kind: "needs_human", reason: "captcha", description: "" },
    ],
    [
      "needs_human with an essay",
      { kind: "needs_human", reason: "captcha", description: "x".repeat(281) },
    ],
    ["impossible because of a captcha", { kind: "impossible", reason: "captcha", detail: "x" }],
    ["impossible without detail", { kind: "impossible", reason: "file_gone", detail: "" }],
  ])("rejects %s", (_label, value) => {
    expect(stepResultSchema.safeParse(value).success).toBe(false);
  });
});

describe("gateResultSchema", () => {
  it("accepts success, needs_human and impossible outcomes", () => {
    const outcomes = [
      { ok: true, download },
      {
        ok: false,
        kind: "needs_human",
        reason: "login_challenge",
        description: "Log in to SoundCloud in the browser window, then click Continue.",
        stepIndex: 1,
        stepName: "connect-soundcloud",
      },
      { ok: false, kind: "impossible", reason: "file_gone", detail: "File removed by uploader" },
    ];

    for (const outcome of outcomes) {
      expect(gateResultSchema.safeParse(outcome).success).toBe(true);
    }
  });

  it("has no failure outcome for human blockers", () => {
    expect(
      gateResultSchema.safeParse({ ok: false, kind: "failed", reason: "captcha" }).success,
    ).toBe(false);
    expect(
      gateResultSchema.safeParse({ ok: false, kind: "impossible", reason: "captcha", detail: "x" })
        .success,
    ).toBe(false);
  });
});

describe("validateGateAdapter", () => {
  const next = (): Promise<StepResult> => Promise.resolve({ kind: "next" });
  const adapter: GateAdapter = {
    id: "example-gate",
    priority: 10,
    detect: (url) => url.hostname === "gate.example",
    steps: [
      { name: "open-gate", run: next },
      { name: "download", run: next },
    ],
  };

  it("accepts a well-formed adapter", () => {
    expect(validateGateAdapter(adapter)).toEqual({ ok: true });
  });

  it("accepts an adapter that names the hosts it stays on", () => {
    expect(validateGateAdapter({ ...adapter, allowedHosts: ["gate.example"] })).toEqual({
      ok: true,
    });
  });

  it.each([
    ["a non-kebab id", { ...adapter, id: "Example Gate" }],
    ["no steps", { ...adapter, steps: [] }],
    ["a fractional priority", { ...adapter, priority: 1.5 }],
    ["an empty list of allowed hosts", { ...adapter, allowedHosts: [] }],
    [
      "duplicate step names",
      { ...adapter, steps: [...adapter.steps, { name: "download", run: next }] },
    ],
  ])("rejects %s", (_label, invalid) => {
    const result = validateGateAdapter(invalid);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("invalid_adapter");
  });
});
