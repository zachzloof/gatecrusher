import type { HumanReason } from "@gatecrusher/core";
import { SectionLabel } from "@/components/section-label";
import { StatusBadge } from "@/components/status-badge";
import type { TrackDto } from "@/lib/api-schemas";
import { trackStatus } from "@/lib/track-status";

const REASON_LABELS: Record<HumanReason, string> = {
  captcha: "a captcha",
  email_confirmation: "an email confirmation",
  login_challenge: "a sign-in prompt",
  unexpected_page: "a page Gatecrusher did not expect",
  agent_request: "a question from the browser agent",
};

/**
 * The tracks that are waiting for the human: what each one needs, and a screenshot to
 * find the right tab by. A plain list; the Continue / Give up cards replace it later.
 */
export function PausedTracks({ tracks }: { tracks: readonly TrackDto[] }) {
  const paused = tracks.flatMap((track) => {
    const { job } = track;
    if (trackStatus(track) !== "WAITING_FOR_HUMAN" || job === null || job.needsHuman === null) {
      return [];
    }
    return [{ track, needsHuman: job.needsHuman, stepName: job.stepName }];
  });
  if (paused.length === 0) return null;

  return (
    <section aria-labelledby="paused-heading" className="mb-4">
      <SectionLabel id="paused-heading">Paused</SectionLabel>
      <p className="mb-2 max-w-prose text-13 text-text-muted">
        Do what each track asks in the worker&apos;s browser window, then click Run native tracks
        again to retry.
      </p>
      <ul className="divide-y divide-border rounded-panel border border-border bg-surface-1">
        {paused.map(({ track, needsHuman, stepName }) => (
          <li key={track.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <StatusBadge status="WAITING_FOR_HUMAN" />
                <span
                  className="min-w-0 truncate text-text"
                  title={`${track.artist} - ${track.title}`}
                >
                  {track.artist} — {track.title}
                </span>
              </div>
              <p className="mt-1 text-13 text-text">{needsHuman.description}</p>
              {stepName !== null && (
                <p className="mt-0.5 font-mono text-xs text-text-muted">step {stepName}</p>
              )}
            </div>
            <a
              href={needsHuman.screenshotUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 rounded-control border border-border transition-colors duration-150 ease-out hover:border-text-muted"
            >
              {/* A plain <img>: a local PNG served by our own route, shown as a thumbnail. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={needsHuman.screenshotUrl}
                alt={`Screenshot of the tab for ${track.title}, showing ${REASON_LABELS[needsHuman.reason]}. Opens full size.`}
                width={192}
                height={120}
                loading="lazy"
                decoding="async"
                className="h-[7.5rem] w-48 rounded-control bg-surface-2 object-cover object-top"
              />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
