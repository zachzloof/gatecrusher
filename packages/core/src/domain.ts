import { z } from "zod";

/** How a track can be obtained, decided by the classifier from SoundCloud metadata. */
export const TRACK_CLASSIFICATIONS = ["native", "gate", "buy", "none"] as const;
export const trackClassificationSchema = z.enum(TRACK_CLASSIFICATIONS);
export type TrackClassification = z.infer<typeof trackClassificationSchema>;

/** Where a playlist's metadata came from. `yt_dlp` is the fallback when api-v2 fails. */
export const INGEST_SOURCES = ["api_v2", "yt_dlp"] as const;
export const ingestSourceSchema = z.enum(INGEST_SOURCES);
export type IngestSource = z.infer<typeof ingestSourceSchema>;

/** Why a job is parked for the human. None of these may ever end in FAILED or MANUAL. */
export const HUMAN_REASONS = [
  "captcha",
  "email_confirmation",
  "login_challenge",
  "unexpected_page",
  "agent_request",
] as const;
export const humanReasonSchema = z.enum(HUMAN_REASONS);
export type HumanReason = z.infer<typeof humanReasonSchema>;

/** The only reasons a track may be marked MANUAL. */
export const MANUAL_REASONS = [
  "dead_link",
  "file_gone",
  "account_required",
  /** SoundCloud only streams the track DRM-protected; it is never circumvented. */
  "drm_protected",
  "user_gave_up",
] as const;
export const manualReasonSchema = z.enum(MANUAL_REASONS);
export type ManualReason = z.infer<typeof manualReasonSchema>;

export const HUMAN_REQUEST_STATUSES = ["OPEN", "CONTINUED", "GAVE_UP", "SUPERSEDED"] as const;
export const humanRequestStatusSchema = z.enum(HUMAN_REQUEST_STATUSES);
export type HumanRequestStatus = z.infer<typeof humanRequestStatusSchema>;

export const DOWNLOAD_KINDS = ["audio", "archive"] as const;
export const downloadKindSchema = z.enum(DOWNLOAD_KINDS);
export type DownloadKind = z.infer<typeof downloadKindSchema>;

export const RUN_STATUSES = ["RUNNING", "FINISHED"] as const;
export const runStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof runStatusSchema>;
