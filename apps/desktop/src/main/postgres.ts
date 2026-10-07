// The app's private Postgres: real Postgres binaries shipped with the app, a data
// folder in the user's local app data, listening on 127.0.0.1 only, password-protected.
// pg_ctl starts and stops it (on Windows it also drops administrator rights, which
// Postgres requires).
import { spawn } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { executable } from "./paths.ts";

export const DB_USER = "gatecrusher";
export const DB_NAME = "gatecrusher";

export interface PostgresOptions {
  /** Contains bin/, lib/ and share/. */
  installDir: string;
  dataDir: string;
  logFile: string;
  password: string;
  port: number;
  platform: NodeJS.Platform;
}

export interface RunningPostgres {
  /** A connection string for web, worker and migrations. Contains the password. */
  url: string;
  stop(): Promise<void>;
}

function tool(options: PostgresOptions, name: "initdb" | "pg_ctl"): string {
  return path.join(options.installDir, "bin", executable(name, options.platform));
}

/** The exact command lines, kept pure so they are tested. */
export function postgresCommands(options: PostgresOptions, passwordFile: string) {
  return {
    initdb: [
      "-D",
      options.dataDir,
      "-U",
      DB_USER,
      `--pwfile=${passwordFile}`,
      "--auth=scram-sha-256",
      "-E",
      "UTF8",
      "--no-locale",
      "--no-instructions",
    ],
    start: [
      "start",
      "-D",
      options.dataDir,
      "-l",
      options.logFile,
      "-w",
      "-t",
      "60",
      // No Unix socket, TCP on loopback only: nothing outside this machine can connect.
      "-o",
      `-p ${options.port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`,
    ],
    stop: ["stop", "-D", options.dataDir, "-m", "fast", "-w", "-t", "30"],
  };
}

interface RunResult {
  code: number | null;
  output: string;
}

/**
 * Runs a Postgres tool to completion. Waits for the process to exit, not for its output
 * to close: the server pg_ctl starts inherits pg_ctl's output handles on Windows and
 * would keep them open for as long as it runs.
 */
function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    const collect = (chunk: Buffer): void => {
      if (output.length < 8_000) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code) => {
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, output: output.trim() });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    // Not there (or not reachable): treated the same.
    return false;
  }
}

export function databaseExists(dataDir: string): Promise<boolean> {
  return exists(path.join(dataDir, "PG_VERSION"));
}

function connectionUrl(options: PostgresOptions, database: string): string {
  const url = new URL(`postgres://127.0.0.1:${options.port}/${database}`);
  url.username = DB_USER;
  url.password = options.password;
  return url.toString();
}

/** Creates the data folder on first start, then starts the server and the database. */
export async function startPostgres(options: PostgresOptions): Promise<RunningPostgres> {
  const passwordFile = path.join(path.dirname(options.dataDir), `.pgpass-${process.pid}`);
  const commands = postgresCommands(options, passwordFile);
  const pgCtl = tool(options, "pg_ctl");

  if (!(await databaseExists(options.dataDir))) {
    await writeFile(passwordFile, options.password, { encoding: "utf8", mode: 0o600 });
    try {
      const init = await run(tool(options, "initdb"), commands.initdb);
      if (init.code !== 0) throw new Error(`initdb failed: ${init.output}`);
    } finally {
      await rm(passwordFile, { force: true });
    }
  }

  // A server left running by a crashed app holds the data folder; stop it first. When
  // nothing is running this fails, which is fine.
  if (await exists(path.join(options.dataDir, "postmaster.pid"))) {
    await run(pgCtl, commands.stop);
  }

  const started = await run(pgCtl, commands.start);
  if (started.code !== 0) {
    throw new Error(`Postgres did not start (see postgres.log): ${started.output}`);
  }

  const admin = postgres(connectionUrl(options, "postgres"), {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const found = await admin`select 1 from pg_database where datname = ${DB_NAME}`;
    // DB_NAME is a constant identifier, not input.
    if (found.length === 0) await admin.unsafe(`create database "${DB_NAME}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  return {
    url: connectionUrl(options, DB_NAME),
    stop: async () => {
      await run(pgCtl, commands.stop);
    },
  };
}
