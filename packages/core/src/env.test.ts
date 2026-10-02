import { describe, expect, it } from "vitest";
import { ENV_VAR_DOCS, isEnvVarSet, parseEnv, webEnvSchema, workerEnvSchema } from "./env.ts";

const valid = {
  DATABASE_URL: "postgres://user:hunter2@localhost:5432/gatecrusher",
  REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const result = parseEnv(workerEnvSchema, valid);

    expect(result).toEqual({
      ok: true,
      env: {
        ...valid,
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        DATA_DIR: "./data",
        MIN_DOWNLOAD_BYTES: 1_048_576,
      },
    });
  });

  it("coerces numeric variables", () => {
    const result = parseEnv(workerEnvSchema, { ...valid, MIN_DOWNLOAD_BYTES: "2048" });

    expect(result.ok && result.env.MIN_DOWNLOAD_BYTES).toBe(2048);
  });

  it.each(["1", "true", "TRUE", "yes", "new"])(
    "refuses a worker environment asking for headless mode (HEADLESS=%s)",
    (value) => {
      const result = parseEnv(workerEnvSchema, { ...valid, HEADLESS: value });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.variable)).toEqual(["HEADLESS"]);
      expect(result.reason).toContain("never runs headless");
    },
  );

  it.each(["0", "false", "False", "no", ""])("accepts HEADLESS=%j as headed", (value) => {
    expect(parseEnv(workerEnvSchema, { ...valid, HEADLESS: value }).ok).toBe(true);
  });

  it("treats empty values as not set", () => {
    const result = parseEnv(workerEnvSchema, { ...valid, ANTHROPIC_API_KEY: "", LOG_LEVEL: " " });

    expect(result.ok && result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ok && result.env.LOG_LEVEL).toBe("info");
  });

  it("names every missing required variable", () => {
    const result = parseEnv(webEnvSchema, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("invalid_env");
    expect(result.issues).toEqual([
      { variable: "DATABASE_URL", message: "is required but not set" },
      { variable: "REDIS_URL", message: "is required but not set" },
    ]);
    expect(result.reason).toContain("DATABASE_URL: is required but not set");
    expect(result.reason).toContain(".env.example");
  });

  it.each([
    ["DATABASE_URL", "mysql://user:hunter2@localhost/db"],
    ["DATABASE_URL", "not a url"],
    ["REDIS_URL", "http://localhost:6379"],
    ["LOG_LEVEL", "loud"],
    ["NODE_ENV", "staging"],
    ["MIN_DOWNLOAD_BYTES", "big"],
    ["MIN_DOWNLOAD_BYTES", "-5"],
  ])("rejects a malformed %s without echoing its value", (name, value) => {
    const result = parseEnv(workerEnvSchema, { ...valid, [name]: value });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.variable)).toEqual([name]);
    expect(result.reason).not.toContain(value);
    expect(result.reason).not.toContain("hunter2");
  });
});

describe("isEnvVarSet", () => {
  it("is true only for non-empty values", () => {
    expect(isEnvVarSet({ A: "x" }, "A")).toBe(true);
    expect(isEnvVarSet({ A: "" }, "A")).toBe(false);
    expect(isEnvVarSet({ A: "  " }, "A")).toBe(false);
    expect(isEnvVarSet({}, "A")).toBe(false);
  });
});

describe("ENV_VAR_DOCS", () => {
  it("documents exactly the variables the schemas read", () => {
    const schemaKeys = new Set([
      ...Object.keys(webEnvSchema.shape),
      ...Object.keys(workerEnvSchema.shape),
    ]);

    expect(new Set(ENV_VAR_DOCS.map((doc) => doc.name))).toEqual(schemaKeys);
  });
});
