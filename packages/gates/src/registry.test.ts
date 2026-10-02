import type { GateAdapter, StepResult } from "@gatecrusher/core";
import { describe, expect, it } from "vitest";
import { NATIVE_ADAPTER_ID } from "./native/adapter.ts";
import { createRegistry, registry } from "./registry.ts";

const next = (): Promise<StepResult> => Promise.resolve({ kind: "next" });

function fake(id: string, priority: number, hostname: string): GateAdapter {
  return {
    id,
    priority,
    detect: (url) => url.hostname === hostname,
    steps: [{ name: "open-gate", run: next }],
  };
}

describe("createRegistry", () => {
  it("resolves to the highest-priority adapter that detects the URL", () => {
    const fallback: GateAdapter = { ...fake("catch-all", 0, ""), detect: () => true };
    const built = createRegistry([fallback, fake("specific", 50, "gate.example")]);

    expect(built.resolve(new URL("https://gate.example/x"))?.id).toBe("specific");
    expect(built.resolve(new URL("https://other.example/x"))?.id).toBe("catch-all");
    expect(built.adapters.map((adapter) => adapter.id)).toEqual(["specific", "catch-all"]);
  });

  it("resolves to null when nothing detects the URL", () => {
    const built = createRegistry([fake("specific", 50, "gate.example")]);

    expect(built.resolve(new URL("https://other.example/x"))).toBeNull();
  });

  it("refuses duplicate adapter ids", () => {
    expect(() =>
      createRegistry([fake("twin", 1, "a.example"), fake("twin", 2, "b.example")]),
    ).toThrow('Duplicate gate adapter id "twin"');
  });

  it("refuses a malformed adapter", () => {
    const duplicateSteps: GateAdapter = {
      ...fake("bad-steps", 1, "a.example"),
      steps: [
        { name: "open-gate", run: next },
        { name: "open-gate", run: next },
      ],
    };

    expect(() => createRegistry([duplicateSteps])).toThrow(/step names must be unique/);
    expect(() => createRegistry([fake("Not Kebab", 1, "a.example")])).toThrow(
      /Invalid gate adapter/,
    );
  });
});

describe("the worker's registry", () => {
  it("has unique adapter ids and unique step names within each adapter", () => {
    const ids = registry.adapters.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const adapter of registry.adapters) {
      const names = adapter.steps.map((step) => step.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it.each([
    ["https://soundcloud.com/fixture-artist/fixture-track", NATIVE_ADAPTER_ID],
    ["https://m.soundcloud.com/fixture-artist/fixture-track", NATIVE_ADAPTER_ID],
  ])("resolves %s to %s", (url, adapterId) => {
    expect(registry.resolve(new URL(url))?.id).toBe(adapterId);
  });

  it.each(["https://hypeddit.com/track/abc123", "https://example.com/free-download"])(
    "has no adapter yet for %s",
    (url) => {
      expect(registry.resolve(new URL(url))).toBeNull();
    },
  );

  it("keeps the native adapter's step names stable: they are stored in the database", () => {
    const native = registry.adapters.find((adapter) => adapter.id === NATIVE_ADAPTER_ID);

    expect(native?.steps.map((step) => step.name)).toEqual(["open-track", "open-more", "download"]);
  });
});
