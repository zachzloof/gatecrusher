import { z } from "zod";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const baseShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: "must be a postgres:// URL" }),
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: "must be a redis:// URL" }),
};

const dataDir = z.string().min(1).default("./data");
const ytDlpPath = z.string().min(1).default("yt-dlp");

/**
 * How native (uploader-enabled) downloads are fetched. `yt-dlp` asks yt-dlp for the
 * uploader's original file and never opens a browser. `browser` is the paused slice 3
 * path: it drives a visible browser, which SoundCloud's anti-bot check refused — see
 * docs/PIVOT.md. It stays available only by explicit choice.
 */
export const NATIVE_DOWNLOAD_MODES = ["yt-dlp", "browser"] as const;
export const nativeDownloadModeSchema = z.enum(NATIVE_DOWNLOAD_MODES);
export type NativeDownloadMode = z.infer<typeof nativeDownloadModeSchema>;

export const webEnvSchema = z.object({
  ...baseShape,
  YT_DLP_PATH: ytDlpPath,
  DATA_DIR: dataDir,
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export const workerEnvSchema = z.object({
  ...baseShape,
  DATA_DIR: dataDir,
  YT_DLP_PATH: ytDlpPath,
  NATIVE_DOWNLOAD_MODE: nativeDownloadModeSchema.default("yt-dlp"),
  MIN_DOWNLOAD_BYTES: z.coerce
    .number({ error: "must be a number of bytes" })
    .int()
    .positive()
    .default(1_048_576),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  // Hard rule: the worker's browser is always visible. There is no headless mode to
  // turn on, so asking for one is a configuration error rather than something to ignore.
  HEADLESS: z
    .string()
    .optional()
    .refine((value) => value === undefined || ["0", "false", "no"].includes(value.toLowerCase()), {
      error:
        "the worker never runs headless: a human has to see and use its browser window. Remove this variable",
    }),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** For scripts that only talk to Postgres (migrate, seed). */
export const databaseEnvSchema = z.object({
  LOG_LEVEL: baseShape.LOG_LEVEL,
  DATABASE_URL: baseShape.DATABASE_URL,
});
export type DatabaseEnv = z.infer<typeof databaseEnvSchema>;

export interface EnvIssue {
  variable: string;
  message: string;
}

export type EnvResult<T> =
  { ok: true; env: T } | { ok: false; kind: "invalid_env"; reason: string; issues: EnvIssue[] };

type EnvSource = Readonly<Record<string, string | undefined>>;

/** `FOO=` in a .env file means "not set", not "set to the empty string". */
function withoutEmptyValues(source: EnvSource): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== "") result[key] = value;
  }
  return result;
}

/**
 * Validates an environment against a schema. The failure reason names each offending
 * variable and what is wrong with it, and never includes a value.
 */
export function parseEnv<S extends z.ZodType>(schema: S, source: EnvSource): EnvResult<z.infer<S>> {
  const present = withoutEmptyValues(source);
  const parsed = schema.safeParse(present);
  if (parsed.success) return { ok: true, env: parsed.data };

  const issues = parsed.error.issues.map((issue): EnvIssue => {
    const variable = issue.path.map(String).join(".") || "(environment)";
    const message = variable in present ? issue.message : "is required but not set";
    return { variable, message };
  });

  const reason = [
    "Invalid environment configuration:",
    ...issues.map((issue) => `  - ${issue.variable}: ${issue.message}`),
    "Set these in the root .env file. See .env.example for what each variable means.",
  ].join("\n");

  return { ok: false, kind: "invalid_env", reason, issues };
}

export interface EnvVarDoc {
  name: string;
  usedBy: ReadonlyArray<"web" | "worker">;
  required: boolean;
  description: string;
}

/** Shown on the Settings page (set / not set only, never values). Mirrors .env.example. */
export const ENV_VAR_DOCS: readonly EnvVarDoc[] = [
  {
    name: "DATABASE_URL",
    usedBy: ["web", "worker"],
    required: true,
    description: "Postgres connection string.",
  },
  {
    name: "REDIS_URL",
    usedBy: ["web", "worker"],
    required: true,
    description: "Redis connection string for the queue, live events and worker heartbeat.",
  },
  {
    name: "NODE_ENV",
    usedBy: ["web", "worker"],
    required: false,
    description: "development, test or production. Defaults to development.",
  },
  {
    name: "LOG_LEVEL",
    usedBy: ["web", "worker"],
    required: false,
    description: "pino log level. Defaults to info.",
  },
  {
    name: "YT_DLP_PATH",
    usedBy: ["web", "worker"],
    required: false,
    description:
      "yt-dlp executable: the worker downloads native tracks with it, web uses it for playlist metadata when SoundCloud's API fails. Defaults to yt-dlp on PATH.",
  },
  {
    name: "NATIVE_DOWNLOAD_MODE",
    usedBy: ["worker"],
    required: false,
    description:
      "yt-dlp (default, no browser) or browser (the paused slice 3 path; see docs/PIVOT.md).",
  },
  {
    name: "DATA_DIR",
    usedBy: ["web", "worker"],
    required: false,
    description:
      "Browser profile, downloads and screenshots; web serves the screenshots. Defaults to ./data.",
  },
  {
    name: "MIN_DOWNLOAD_BYTES",
    usedBy: ["worker"],
    required: false,
    description: "Smallest file accepted as a download. Defaults to 1 MB.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    usedBy: ["worker"],
    required: false,
    description: "API key for the AI browser-agent fallback.",
  },
  {
    name: "HEADLESS",
    usedBy: ["worker"],
    required: false,
    description: "Leave unset: the worker refuses to start if asked to run headless.",
  },
];

/** Whether a variable has a non-empty value. Deliberately returns nothing else about it. */
export function isEnvVarSet(source: EnvSource, name: string): boolean {
  const value = source[name];
  return value !== undefined && value.trim() !== "";
}
