import { execFile } from "node:child_process";

export type ProcessResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: "not_installed" | "timeout" | "failed"; detail: string; stdout: string };

/** Runs a program with an argument array. Never through a shell. */
export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: { timeoutMs: number },
  ): Promise<ProcessResult>;
}

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const execFileRunner: ProcessRunner = {
  run: (command, args, { timeoutMs }) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ ok: true, stdout, stderr });
          } else if ("code" in error && error.code === "ENOENT") {
            resolve({
              ok: false,
              kind: "not_installed",
              detail: `${command} was not found`,
              stdout,
            });
          } else if (error.killed === true) {
            resolve({
              ok: false,
              kind: "timeout",
              detail: `timed out after ${timeoutMs}ms`,
              stdout,
            });
          } else {
            resolve({ ok: false, kind: "failed", detail: stderr.trim() || error.message, stdout });
          }
        },
      );
    }),
};
