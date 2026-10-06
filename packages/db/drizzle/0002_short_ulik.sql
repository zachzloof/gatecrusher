CREATE TABLE "soundcloud_account" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"oauth_token" text NOT NULL,
	"soundcloud_user_id" text NOT NULL,
	"username" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "soundcloud_account_single_row" CHECK ("soundcloud_account"."id" = 1)
);
