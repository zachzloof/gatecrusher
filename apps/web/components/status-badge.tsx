import type { JobStatus, TrackClassification } from "@gatecrusher/core";
import { cn } from "@/lib/utils";

/**
 * Every status the UI shows goes through this one mapping: how a track can be obtained
 * (its classification) and where its job stands.
 */
export type Status = TrackClassification | JobStatus;

interface StatusStyle {
  label: string;
  /** Colour of the dot. The label always carries the meaning as text. */
  dot: string;
  text: string;
  /** The running indicator and the Needs-you pulse are the only looping animations. */
  pulse?: boolean;
}

const STATUS_STYLES: Record<Status, StatusStyle> = {
  native: { label: "Native", dot: "bg-text", text: "text-text" },
  gate: { label: "Gate", dot: "bg-info", text: "text-text" },
  buy: { label: "Buy", dot: "bg-warn", text: "text-warn" },
  // Faint is below body-text contrast, so only the dot uses it.
  none: { label: "No download", dot: "bg-text-faint", text: "text-text-muted" },

  QUEUED: { label: "Queued", dot: "bg-text-muted", text: "text-text-muted" },
  RUNNING: { label: "Running", dot: "bg-info", text: "text-info", pulse: true },
  WAITING_FOR_HUMAN: { label: "Needs you", dot: "bg-accent", text: "text-accent", pulse: true },
  SUCCEEDED: { label: "Downloaded", dot: "bg-ok", text: "text-ok" },
  MANUAL: { label: "Manual", dot: "bg-manual", text: "text-manual" },
  FAILED: { label: "Failed", dot: "bg-danger", text: "text-danger" },
};

export function statusLabel(status: Status): string {
  return STATUS_STYLES[status].label;
}

interface StatusBadgeProps {
  status: Status;
  /** Shown after the label, e.g. the step a running job is on. */
  detail?: string | null | undefined;
  className?: string;
}

export function StatusBadge({ status, detail, className }: StatusBadgeProps) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-13 whitespace-nowrap",
        style.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          style.dot,
          style.pulse === true && "animate-pulse",
        )}
      />
      <span className="truncate">
        {style.label}
        {detail !== undefined && detail !== null && detail !== "" && (
          <span className="font-mono text-xs text-text-muted">{` · ${detail}`}</span>
        )}
      </span>
    </span>
  );
}
