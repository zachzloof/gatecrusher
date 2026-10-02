import {
  PING_JOB_NAME,
  pingJobPayloadSchema,
  TRACK_JOB_NAME,
  trackJobPayloadSchema,
  type PingJobResult,
  type TrackJobResult,
} from "@gatecrusher/core";
import type { DelayProvider } from "@gatecrusher/gates";
import type { Logger } from "pino";

/** The parts of a BullMQ job the processor reads. Payloads are untrusted until parsed. */
export interface IncomingJob {
  id?: string | undefined;
  name: string;
  data: unknown;
}

export interface ProcessorDeps {
  log: Logger;
  now?: () => Date;
  /** Runs one browser job to its next resting point. */
  processTrack(jobId: string): Promise<TrackJobResult>;
  delay: DelayProvider;
}

/**
 * Dispatches a queue job by name. Throwing here is the queue-job boundary: BullMQ
 * records the queue job as failed. A track job never throws for something that
 * happened in the browser — that is recorded on the job row instead.
 */
export async function processJob(
  job: IncomingJob,
  deps: ProcessorDeps,
): Promise<PingJobResult | TrackJobResult> {
  const log = deps.log.child({ queueJobId: job.id, jobName: job.name });

  switch (job.name) {
    case PING_JOB_NAME: {
      const payload = pingJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new Error("Invalid ping job payload");
      const result: PingJobResult = {
        pong: true,
        requestedAt: payload.data.requestedAt,
        processedAt: (deps.now?.() ?? new Date()).toISOString(),
      };
      log.info(result, "Processed ping job");
      return result;
    }
    case TRACK_JOB_NAME: {
      const payload = trackJobPayloadSchema.safeParse(job.data);
      if (!payload.success) throw new Error("Invalid track job payload");
      const result = await deps.processTrack(payload.data.jobId);
      // Hard rule: behave like a slow human. The pause sits inside the queue job, so
      // the next track cannot start before it is over.
      if (result.outcome !== "skipped") await deps.delay.wait("between-jobs");
      return result;
    }
    default:
      throw new Error(`No processor registered for job "${job.name}"`);
  }
}
