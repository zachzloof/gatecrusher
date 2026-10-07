"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { MyPlaylistsPicker } from "@/components/my-playlists-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addPlaylistRequestSchema,
  addPlaylistResponseSchema,
  apiErrorSchema,
  type AddPlaylistResponse,
  type MyPlaylistDto,
} from "@/lib/api-schemas";
import { cn } from "@/lib/utils";

/** Where the playlist comes from: a pasted URL, or the connected account's library. */
type Source = "url" | "mine";

const SOURCES: ReadonlyArray<{ value: Source; label: string }> = [
  { value: "url", label: "Paste a URL" },
  { value: "mine", label: "From my SoundCloud" },
];

type Outcome =
  | { kind: "idle" }
  /** `playlistId` is set when a tile of the picker was clicked. */
  | { kind: "submitting"; playlistId: string | null }
  | { kind: "error"; message: string };

type SubmitResult = { ok: true; playlist: AddPlaylistResponse } | { ok: false; message: string };

async function submitPlaylist(url: string): Promise<SubmitResult> {
  try {
    const response = await fetch("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body: unknown = await response.json();

    if (response.ok) {
      const added = addPlaylistResponseSchema.safeParse(body);
      if (added.success) return { ok: true, playlist: added.data };
    } else {
      const failure = apiErrorSchema.safeParse(body);
      if (failure.success) return { ok: false, message: failure.data.error.message };
    }
    return { ok: false, message: "The server sent an unexpected response. Try again." };
  } catch {
    // fetch rejected or the body was not JSON: the server is not reachable.
    return {
      ok: false,
      message: "Could not reach the server. Check it is running, then try again.",
    };
  }
}

export function AddPlaylistDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("url");
  const [url, setUrl] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const inputId = useId();
  const messageId = useId();

  // Bumped when the dialog closes, so an answer that arrives afterwards is ignored.
  const session = useRef(0);

  const submitting = outcome.kind === "submitting";

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) {
      session.current += 1;
      setSource("url");
      setUrl("");
      setOutcome({ kind: "idle" });
    }
  }

  function switchSource(next: Source): void {
    if (submitting || next === source) return;
    setSource(next);
    setOutcome({ kind: "idle" });
  }

  /** Adds the playlist at `url`, then opens it. Shared by both sources. */
  async function add(playlistUrl: string, playlistId: string | null): Promise<void> {
    setOutcome({ kind: "submitting", playlistId });
    const startedIn = session.current;
    const result = await submitPlaylist(playlistUrl);
    if (session.current !== startedIn) return;

    if (!result.ok) {
      setOutcome({ kind: "error", message: result.message });
      return;
    }
    const { playlistId: id, unavailableCount } = result.playlist;
    const query = unavailableCount > 0 ? `?skipped=${unavailableCount}` : "";
    router.push(`/playlists/${id}${query}`);
    handleOpenChange(false);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const parsed = addPlaylistRequestSchema.safeParse({ url });
    if (!parsed.success) {
      setOutcome({
        kind: "error",
        message: parsed.error.issues[0]?.message ?? "Enter a SoundCloud playlist URL.",
      });
      return;
    }
    await add(parsed.data.url, null);
  }

  function handlePick(playlist: MyPlaylistDto): void {
    if (submitting) return;
    void add(playlist.url, playlist.soundcloudId);
  }

  const message = (
    <div id={messageId} aria-live="polite" className="min-h-10 text-13">
      {outcome.kind === "error" && (
        <p role="alert" className="text-danger">
          {outcome.message}
        </p>
      )}
      {submitting && (
        <p className="text-text-muted">
          Reading the playlist from SoundCloud. Long playlists take a few seconds.
        </p>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="primary">
          <Plus aria-hidden="true" />
          Add playlist
        </Button>
      </DialogTrigger>
      <DialogContent
        className={cn(
          "transition-[max-width] duration-150 ease-out",
          source === "mine" && "sm:max-w-2xl",
        )}
      >
        <DialogHeader>
          <DialogTitle>Add playlist</DialogTitle>
          <DialogDescription>
            {source === "url"
              ? "Paste a SoundCloud playlist URL. Every track in it gets classified."
              : "Pick a playlist from the connected SoundCloud account. Every track in it gets classified."}
          </DialogDescription>
        </DialogHeader>

        <div role="group" aria-label="Playlist source" className="flex gap-1">
          {SOURCES.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={source === option.value}
              onClick={() => switchSource(option.value)}
              disabled={submitting}
              className={cn(
                "inline-flex h-8 items-center rounded-control border px-2.5 text-13 transition-colors duration-150 ease-out disabled:pointer-events-none",
                source === option.value
                  ? "border-border bg-surface-2 text-text"
                  : "border-transparent text-text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {source === "url" ? (
          <form onSubmit={(event) => void handleSubmit(event)} noValidate className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor={inputId}>Playlist URL</Label>
              <Input
                id={inputId}
                name="url"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://soundcloud.com/artist/sets/name"
                className="font-mono text-13"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  if (!submitting) setOutcome({ kind: "idle" });
                }}
                disabled={submitting}
                aria-invalid={outcome.kind === "error"}
                aria-describedby={messageId}
              />
              {message}
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" disabled={submitting}>
                {submitting ? "Reading…" : "Add playlist"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-2">
            <MyPlaylistsPicker
              onPick={handlePick}
              busyId={outcome.kind === "submitting" ? outcome.playlistId : null}
            />
            {message}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
