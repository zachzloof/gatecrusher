// Web and worker as child processes of the app (Electron utility processes, which run
// on the Node.js inside Electron). Their output goes to logs/<name>.log.
import { setTimeout as sleep } from "node:timers/promises";
import { utilityProcess, type UtilityProcess } from "electron";
import type { MainLog } from "./log.ts";

export interface ServiceSpec {
  name: "web" | "worker";
  modulePath: string;
  cwd: string;
  env: Record<string, string>;
  /** Asked to stop with a "shutdown" message first (the worker), or just stopped (web). */
  graceful: boolean;
}

export interface RunningService {
  /** Resolves when the process has gone. */
  stop(): Promise<void>;
  exited(): boolean;
}

const STOP_GRACE_MS = 5_000;

export function startService(
  spec: ServiceSpec,
  log: MainLog,
  onUnexpectedExit: (code: number) => void,
): RunningService {
  let stopping = false;
  let gone = false;
  const child: UtilityProcess = utilityProcess.fork(spec.modulePath, [], {
    cwd: spec.cwd,
    env: spec.env,
    stdio: "pipe",
    serviceName: `Gatecrusher ${spec.name}`,
  });
  const output = log.stream(spec.name);
  child.stdout?.pipe(output, { end: false });
  child.stderr?.pipe(output, { end: false });

  const exit = new Promise<number>((resolve) => {
    child.once("exit", (code) => {
      gone = true;
      resolve(code);
    });
  });
  void exit.then((code) => {
    log[stopping ? "info" : "error"](`${spec.name} exited`, { code });
    if (!stopping) onUnexpectedExit(code);
  });
  log.info(`${spec.name} started`, { pid: child.pid });

  return {
    exited: () => gone,
    stop: async () => {
      if (gone) return;
      stopping = true;
      if (!spec.graceful) {
        child.kill();
        await exit;
        return;
      }
      // The worker ends its downloads and cleans up on this message; it is killed if it
      // has not gone in time.
      child.postMessage("shutdown");
      const timedOut = await Promise.race([
        exit.then(() => false),
        sleep(STOP_GRACE_MS).then(() => true),
      ]);
      if (timedOut) {
        child.kill();
        await exit;
      }
    },
  };
}

/**
 * Resolves once the web server answers at all (its health route answers 503 while the
 * worker is still starting, which is fine here). Rejects if it never does.
 */
export async function waitForWeb(
  url: string,
  service: RunningService,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.exited()) throw new Error("The web server stopped while starting (see web.log)");
    try {
      await fetch(new URL("/api/health", url), { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      // Not listening yet.
      await sleep(250);
    }
  }
  throw new Error("The web server did not start in time (see web.log)");
}
