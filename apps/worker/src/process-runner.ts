import { execFile, spawn, type ChildProcess } from "node:child_process";

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

/** Every program started through `execFileRunner` that has not exited yet. */
const running = new Set<ChildProcess>();

/**
 * Ends every program the runner started, with whatever they started in turn. Used when
 * the worker has to stop at once (the desktop app quitting) instead of after its job.
 */
export function killRunningProcesses(): void {
  for (const child of running) {
    if (child.pid === undefined) continue;
    if (process.platform === "win32") {
      // child.kill() would leave yt-dlp's own children (ffmpeg) running on Windows.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGKILL");
    }
  }
}

export const execFileRunner: ProcessRunner = {
  run: (command, args, { timeoutMs }) =>
    new Promise((resolve) => {
      const child = execFile(
        command,
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false },
        (error, stdout, stderr) => {
          running.delete(child);
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
      running.add(child);
    }),
};
