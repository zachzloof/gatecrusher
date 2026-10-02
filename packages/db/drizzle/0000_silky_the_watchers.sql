CREATE TYPE "public"."download_kind" AS ENUM('audio', 'archive');--> statement-breakpoint
CREATE TYPE "public"."human_reason" AS ENUM('captcha', 'email_confirmation', 'login_challenge', 'unexpected_page', 'agent_request');--> statement-breakpoint
CREATE TYPE "public"."human_request_status" AS ENUM('OPEN', 'CONTINUED', 'GAVE_UP', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'WAITING_FOR_HUMAN', 'SUCCEEDED', 'MANUAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."manual_reason" AS ENUM('dead_link', 'file_gone', 'account_required', 'user_gave_up');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('RUNNING', 'FINISHED');--> statement-breakpoint
CREATE TYPE "public"."track_classification" AS ENUM('native', 'gate', 'buy', 'none');--> statement-breakpoint
CREATE TABLE "downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"job_id" uuid,
	"file_path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"kind" "download_kind" NOT NULL,
	"checksum_sha256" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"type" text NOT NULL,
	"step_index" integer,
	"step_name" text,
	"screenshot_path" text,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"reason" "human_reason" NOT NULL,
	"description" text NOT NULL,
	"screenshot_path" text NOT NULL,
	"page_url" text NOT NULL,
	"adapter_id" text NOT NULL,
	"step_index" integer NOT NULL,
	"step_name" text NOT NULL,
	"status" "human_request_status" DEFAULT 'OPEN' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"session_alive" boolean DEFAULT true NOT NULL,
	"give_up_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"track_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"adapter_id" text,
	"step_index" integer DEFAULT 0 NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"manual_reason" "manual_reason",
	"manual_detail" text,
	"manual_link" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_manual_has_reason_and_link" CHECK ("jobs"."status" <> 'MANUAL' OR ("jobs"."manual_reason" IS NOT NULL AND "jobs"."manual_link" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"soundcloud_url" text NOT NULL,
	"soundcloud_id" text,
	"title" text NOT NULL,
	"owner" text,
	"artwork_url" text,
	"last_ingested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'RUNNING' NOT NULL,
	"total_jobs" integer DEFAULT 0 NOT NULL,
	"succeeded_count" integer DEFAULT 0 NOT NULL,
	"manual_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL,
	"soundcloud_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"permalink_url" text NOT NULL,
	"artwork_url" text,
	"duration_ms" integer,
	"purchase_url" text,
	"purchase_title" text,
	"downloadable" boolean DEFAULT false NOT NULL,
	"classification" "track_classification" DEFAULT 'none' NOT NULL,
	"gate_platform" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_requests" ADD CONSTRAINT "human_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_playlist_id_playlists_id_fk" FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "downloads_track_key" ON "downloads" USING btree ("track_id");--> statement-breakpoint
CREATE INDEX "events_run_id_idx" ON "events" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "events_job_id_idx" ON "events" USING btree ("job_id","id");--> statement-breakpoint
CREATE INDEX "human_requests_job_idx" ON "human_requests" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "human_requests_status_idx" ON "human_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "human_requests_one_open_per_job_key" ON "human_requests" USING btree ("job_id") WHERE "human_requests"."status" = 'OPEN';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_run_track_key" ON "jobs" USING btree ("run_id","track_id");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "jobs_track_idx" ON "jobs" USING btree ("track_id");--> statement-breakpoint
CREATE UNIQUE INDEX "playlists_soundcloud_url_key" ON "playlists" USING btree ("soundcloud_url");--> statement-breakpoint
CREATE INDEX "runs_playlist_idx" ON "runs" USING btree ("playlist_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_playlist_soundcloud_id_key" ON "tracks" USING btree ("playlist_id","soundcloud_id");--> statement-breakpoint
CREATE INDEX "tracks_playlist_position_idx" ON "tracks" USING btree ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "tracks_classification_idx" ON "tracks" USING btree ("classification");