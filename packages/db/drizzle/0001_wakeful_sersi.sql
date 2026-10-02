CREATE TYPE "public"."ingest_source" AS ENUM('api_v2', 'yt_dlp');--> statement-breakpoint
ALTER TABLE "playlists" ADD COLUMN "ingest_source" "ingest_source";