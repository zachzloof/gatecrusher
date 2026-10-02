import {
  DOWNLOAD_KINDS,
  HUMAN_REASONS,
  HUMAN_REQUEST_STATUSES,
  INGEST_SOURCES,
  JOB_STATUSES,
  MANUAL_REASONS,
  RUN_STATUSES,
  TRACK_CLASSIFICATIONS,
} from "@gatecrusher/core";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Enum values come from `core`, so the database and the zod schemas cannot drift.
export const trackClassification = pgEnum("track_classification", TRACK_CLASSIFICATIONS);
export const ingestSource = pgEnum("ingest_source", INGEST_SOURCES);
export const runStatus = pgEnum("run_status", RUN_STATUSES);
export const jobStatus = pgEnum("job_status", JOB_STATUSES);
export const manualReason = pgEnum("manual_reason", MANUAL_REASONS);
export const humanReason = pgEnum("human_reason", HUMAN_REASONS);
export const humanRequestStatus = pgEnum("human_request_status", HUMAN_REQUEST_STATUSES);
export const downloadKind = pgEnum("download_kind", DOWNLOAD_KINDS);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const playlists = pgTable(
  "playlists",
  {
    id: id(),
    soundcloudUrl: text("soundcloud_url").notNull(),
    soundcloudId: text("soundcloud_id"),
    title: text("title").notNull(),
    owner: text("owner"),
    artworkUrl: text("artwork_url"),
    /** Where the last ingest got its metadata. Null until a playlist has been ingested. */
    ingestSource: ingestSource("ingest_source"),
    lastIngestedAt: timestamp("last_ingested_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex("playlists_soundcloud_url_key").on(table.soundcloudUrl)],
);

export const tracks = pgTable(
  "tracks",
  {
    id: id(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    soundcloudId: text("soundcloud_id").notNull(),
    /** Zero-based order within the playlist. */
    position: integer("position").notNull(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    permalinkUrl: text("permalink_url").notNull(),
    artworkUrl: text("artwork_url"),
    durationMs: integer("duration_ms"),
    purchaseUrl: text("purchase_url"),
    purchaseTitle: text("purchase_title"),
    downloadable: boolean("downloadable").notNull().default(false),
    classification: trackClassification("classification").notNull().default("none"),
    /** hypeddit, toneden, ... or `unknown`; only set for `gate` tracks. */
    gatePlatform: text("gate_platform"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("tracks_playlist_soundcloud_id_key").on(table.playlistId, table.soundcloudId),
    index("tracks_playlist_position_idx").on(table.playlistId, table.position),
    index("tracks_classification_idx").on(table.classification),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: id(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    status: runStatus("status").notNull().default("RUNNING"),
    totalJobs: integer("total_jobs").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    manualCount: integer("manual_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    index("runs_playlist_idx").on(table.playlistId),
    index("runs_status_idx").on(table.status),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    status: jobStatus("status").notNull().default("QUEUED"),
    adapterId: text("adapter_id"),
    /** Checkpoint: the step to (re-)enter next. */
    stepIndex: integer("step_index").notNull().default(0),
    /** The adapter's small serialisable state bag, persisted between steps. */
    state: jsonb("state").notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    manualReason: manualReason("manual_reason"),
    manualDetail: text("manual_detail"),
    manualLink: text("manual_link"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("jobs_run_track_key").on(table.runId, table.trackId),
    index("jobs_status_idx").on(table.status),
    index("jobs_track_idx").on(table.trackId),
    // Hard rule: MANUAL always stores a reason and the link.
    check(
      "jobs_manual_has_reason_and_link",
      sql`${table.status} <> 'MANUAL' OR (${table.manualReason} IS NOT NULL AND ${table.manualLink} IS NOT NULL)`,
    ),
  ],
);

export const events = pgTable(
  "events",
  {
    /** Monotonic, so a client can replay "everything after N". */
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    stepIndex: integer("step_index"),
    stepName: text("step_name"),
    /** Relative to the data dir. */
    screenshotPath: text("screenshot_path"),
    error: text("error"),
    /** Validated against the zod schema for `type` before it is written. */
    payload: jsonb("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("events_run_id_idx").on(table.runId, table.id),
    index("events_job_id_idx").on(table.jobId, table.id),
  ],
);

export const downloads = pgTable(
  "downloads",
  {
    id: id(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Relative to the data dir. */
    filePath: text("file_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    kind: downloadKind("kind").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("downloads_track_key").on(table.trackId)],
);

export const humanRequests = pgTable(
  "human_requests",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    reason: humanReason("reason").notNull(),
    /** Instruction to the user. */
    description: text("description").notNull(),
    screenshotPath: text("screenshot_path").notNull(),
    pageUrl: text("page_url").notNull(),
    adapterId: text("adapter_id").notNull(),
    stepIndex: integer("step_index").notNull(),
    stepName: text("step_name").notNull(),
    status: humanRequestStatus("status").notNull().default("OPEN"),
    attempt: integer("attempt").notNull().default(1),
    /** False once the parked page was lost (worker restart, tab closed, TTL). */
    sessionAlive: boolean("session_alive").notNull().default(true),
    giveUpReason: text("give_up_reason"),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("human_requests_job_idx").on(table.jobId),
    index("human_requests_status_idx").on(table.status),
    // A job waits on at most one open request at a time.
    uniqueIndex("human_requests_one_open_per_job_key")
      .on(table.jobId)
      .where(sql`${table.status} = 'OPEN'`),
  ],
);
