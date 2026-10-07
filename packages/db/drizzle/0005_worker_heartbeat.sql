CREATE TABLE "worker_heartbeat" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "worker_heartbeat_single_row" CHECK ("worker_heartbeat"."id" = 1)
);
