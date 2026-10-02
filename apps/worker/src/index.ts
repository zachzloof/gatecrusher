import { loadEnv } from "./env.ts";
import { createLogger } from "./logger.ts";
import { startWorker } from "./worker.ts";

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);

const started = await startWorker({ env, log });
if (!started.ok) {
  log.fatal({ kind: started.kind }, started.reason);
  process.exit(1);
}

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "Shutting down");

  if (!started.ok) return;
  started.worker
    .close()
    .then(() => {
      log.info("Worker stopped");
      process.exit(0);
    })
    .catch((error: unknown) => {
      log.error({ err: error }, "Worker did not shut down cleanly");
      process.exit(1);
    });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
