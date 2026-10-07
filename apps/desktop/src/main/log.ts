// The desktop app's logs: one file per process in the logs folder, so a friend can send
// them when something goes wrong. Web and worker already write redacted pino JSON; the
// main process writes the same shape. Nothing here ever receives a secret.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";

export interface MainLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** An append-only stream for a child process's output. */
  stream(name: string): WriteStream;
}

function describe(error: unknown): unknown {
  return error instanceof Error ? { message: error.message, stack: error.stack } : error;
}

export function createMainLog(logsDir: string): MainLog {
  mkdirSync(logsDir, { recursive: true });
  const main = createWriteStream(path.join(logsDir, "main.log"), { flags: "a" });

  const write = (level: string, message: string, fields: Record<string, unknown> = {}): void => {
    const entry = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, key === "err" ? describe(value) : value]),
    );
    main.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, service: "desktop", msg: message, ...entry })}\n`,
    );
  };

  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    stream: (name) => createWriteStream(path.join(logsDir, `${name}.log`), { flags: "a" }),
  };
}
