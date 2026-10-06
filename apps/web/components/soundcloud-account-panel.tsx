"use client";

import { CircleCheck, Minus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ErrorState } from "@/components/data-states";
import { SectionLabel } from "@/components/section-label";
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
import { apiErrorSchema, soundcloudAccountResponseSchema } from "@/lib/api-schemas";
import { useApi } from "@/lib/use-api";

type DisconnectOutcome =
  { kind: "idle" } | { kind: "pending" } | { kind: "error"; message: string };

async function disconnect(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch("/api/soundcloud-account", { method: "DELETE" });
    if (response.ok) return { ok: true };
    const failure = apiErrorSchema.safeParse(await response.json());
    return {
      ok: false,
      message: failure.success
        ? failure.data.error.message
        : "The server sent an unexpected response.",
    };
  } catch {
    // fetch rejected or the body was not JSON: the server is not reachable.
    return {
      ok: false,
      message: "Could not reach the server. Check it is running, then try again.",
    };
  }
}

function DisconnectButton({ username, onDone }: { username: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<DisconnectOutcome>({ kind: "idle" });
  const pending = outcome.kind === "pending";

  async function handleConfirm(): Promise<void> {
    setOutcome({ kind: "pending" });
    const result = await disconnect();
    if (!result.ok) {
      setOutcome({ kind: "error", message: result.message });
      return;
    }
    setOpen(false);
    setOutcome({ kind: "idle" });
    onDone();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setOutcome({ kind: "idle" });
      }}
    >
      <DialogTrigger asChild>
        <Button variant="danger-ghost" size="sm">
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disconnect {username}?</DialogTitle>
          <DialogDescription>
            Gatecrusher deletes the saved token. Downloads stop working until you connect an account
            again. Your SoundCloud account itself is not affected.
          </DialogDescription>
        </DialogHeader>
        <p
          aria-live="polite"
          role={outcome.kind === "error" ? "alert" : undefined}
          className="min-h-5 text-13 text-danger"
        >
          {outcome.kind === "error" && outcome.message}
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="danger-ghost" onClick={() => void handleConfirm()} disabled={pending}>
            {pending ? "Disconnecting…" : "Disconnect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings: which SoundCloud account downloads run as, and how to change it. */
export function SoundcloudAccountPanel() {
  const { state, reload, refresh } = useApi(
    "/api/soundcloud-account",
    soundcloudAccountResponseSchema,
  );

  return (
    <section aria-labelledby="soundcloud-heading" className="mb-8">
      <SectionLabel id="soundcloud-heading">SoundCloud account</SectionLabel>

      {state.status === "loading" && (
        <div
          role="status"
          aria-label="Loading the SoundCloud account"
          className="h-14 rounded-panel border border-border bg-surface-1"
        />
      )}

      {state.status === "error" && (
        <ErrorState
          title="Could not load the SoundCloud account"
          error={state.error}
          onRetry={reload}
        />
      )}

      {state.status === "ok" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-border bg-surface-1 px-4 py-3">
          {state.data.connected ? (
            <>
              <p className="flex min-w-0 flex-1 items-center gap-2 text-13 text-text">
                <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden="true" />
                <span className="min-w-0">
                  Connected as <span className="font-medium">{state.data.username}</span>
                  <span className="text-text-muted">
                    {" · checked "}
                    <time dateTime={state.data.verifiedAt}>
                      {new Date(state.data.verifiedAt).toLocaleString()}
                    </time>
                  </span>
                </span>
              </p>
              <div className="flex items-center gap-2">
                <Button asChild size="sm">
                  <Link href="/connect">Replace token</Link>
                </Button>
                <DisconnectButton username={state.data.username} onDone={refresh} />
              </div>
            </>
          ) : (
            <>
              <p className="flex min-w-0 flex-1 items-center gap-2 text-13 text-text-muted">
                <Minus className="size-4 shrink-0" aria-hidden="true" />
                Not connected. Downloads need a signed-in SoundCloud account.
              </p>
              <Button asChild size="sm">
                <Link href="/connect">Connect SoundCloud</Link>
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
