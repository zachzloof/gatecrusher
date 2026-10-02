import { Music } from "lucide-react";
import { safeHref } from "@/lib/format";

/** 32px cover image, or a placeholder of the same size when there is none. */
export function Artwork({ url }: { url: string | null }) {
  const src = safeHref(url);
  if (src === undefined) {
    return (
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-control bg-surface-2 text-text-faint"
      >
        <Music className="size-4" />
      </span>
    );
  }
  return (
    // A plain <img>: these are remote SoundCloud CDN images that next/image would have
    // to fetch and re-encode server-side for a 32px thumbnail.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={32}
      height={32}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="size-8 shrink-0 rounded-control bg-surface-2 object-cover"
    />
  );
}
