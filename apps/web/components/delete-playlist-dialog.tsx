"use client";

import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
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
import {
  apiErrorSchema,
  deletePlaylistResponseSchema,
  type DeletePlaylistResponse,
  type PlaylistSummaryDto,
} from "@/lib/api-schemas";
import { formatBytes } from "@/lib/format";

type Outcome = { kind: "idle" } | { kind: "deleting" } | { kind: "error"; message: string };

type DeleteResult = { ok: true; removed: DeletePlaylistResponse } | { ok: false; message: string };

async function deletePlaylist(playlistId: string): Promise<DeleteResult> {
  try {
    const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
      method: "DELETE",
    });
    const body: unknown = await response.json();

    if (response.ok) {
      const removed = deletePlaylistResponseSchema.safeParse(body);
      if (removed.success) return { ok: true, removed: removed.data };
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

/** What deleting removes from disk, in the dialog's own words. */
function filesSentence({ count, bytes }: PlaylistSummaryDto["downloads"]): string {
  if (count === 0) {
    return "Its download folder is deleted too, with any unfinished downloads in it.";
  }
  return `Its download folder is deleted too: ${count} downloaded ${count === 1 ? "file" : "files"} (${formatBytes(bytes)}) and any unfinished downloads.`;
}

interface DeletePlaylistDialogProps {
  playlist: PlaylistSummaryDto;
  /** Called after the playlist is gone, with what was removed. */
  onDeleted: (removed: DeletePlaylistResponse) => void;
}

export function DeletePlaylistDialog({ playlist, onDeleted }: DeletePlaylistDialogProps) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  // Bumped when the dialog closes, so an answer that arrives afterwards is ignored.
  const session = useRef(0);
  const deleting = outcome.kind === "deleting";

  function handleOpenChange(next: boolean): void {
    if (deleting) return;
    setOpen(next);
    if (!next) {
      session.current += 1;
      setOutcome({ kind: "idle" });
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting) return;
    setOutcome({ kind: "deleting" });
    const startedIn = session.current;
    const result = await deletePlaylist(playlist.id);
    if (session.current !== startedIn) return;

    if (!result.ok) {
      setOutcome({ kind: "error", message: result.message });
      return;
    }
    setOutcome({ kind: "idle" });
    setOpen(false);
    onDeleted(result.removed);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Delete ${playlist.title}`}
          title="Delete playlist"
          className="hover:text-danger"
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="break-words">{`Delete ${playlist.title}?`}</DialogTitle>
          <DialogDescription>
            The playlist and its download history leave Gatecrusher.{" "}
            {filesSentence(playlist.downloads)} This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div aria-live="polite" className="min-h-5 text-13">
          {outcome.kind === "error" && (
            <p role="alert" className="text-danger">
              {outcome.message}
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={deleting}>
              Keep it
            </Button>
          </DialogClose>
          <Button
            variant="danger-ghost"
            className="border border-danger/40"
            onClick={() => void handleDelete()}
            disabled={deleting}
          >
            <Trash2 aria-hidden="true" />
            {deleting ? "Deleting…" : "Delete playlist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
