"use client";

import { CircleCheck, ListMusic } from "lucide-react";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { ErrorState } from "@/components/data-states";
import { SectionLabel } from "@/components/section-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiErrorSchema,
  connectSoundcloudRequestSchema,
  soundcloudAccountResponseSchema,
  type SoundcloudAccountResponse,
} from "@/lib/api-schemas";
import { useApi } from "@/lib/use-api";

type Connected = Extract<SoundcloudAccountResponse, { connected: true }>;

type Outcome =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "connected"; username: string }
  | { kind: "error"; message: string };

type SubmitResult = { ok: true; account: Connected } | { ok: false; message: string };

async function submitToken(token: string): Promise<SubmitResult> {
  try {
    const response = await fetch("/api/soundcloud-account", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const body: unknown = await response.json();

    if (response.ok) {
      const account = soundcloudAccountResponseSchema.safeParse(body);
      if (account.success && account.data.connected) return { ok: true, account: account.data };
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

function ConnectedPanel({ account }: { account: Connected }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-panel border border-border bg-surface-1 px-4 py-3">
      <p className="flex min-w-0 flex-1 items-center gap-2 text-13 text-text">
        <CircleCheck className="size-4 shrink-0 text-ok" aria-hidden="true" />
        <span className="min-w-0">
          Connected as <span className="font-medium">{account.username}</span>
          <span className="text-text-muted">
            {" · since "}
            <time dateTime={account.connectedAt}>
              {new Date(account.connectedAt).toLocaleDateString()}
            </time>
          </span>
        </span>
      </p>
      <Button asChild variant="primary">
        <Link href="/playlists">
          <ListMusic aria-hidden="true" />
          Go to playlists
        </Link>
      </Button>
    </div>
  );
}

/**
 * Where the pasted `oauth_token` goes. Shows who is connected, if anyone; a new token
 * replaces the old one. The field is a password field so the token is not on screen.
 */
export function ConnectSoundcloudForm() {
  const { state, reload, refresh } = useApi(
    "/api/soundcloud-account",
    soundcloudAccountResponseSchema,
  );
  const [token, setToken] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const inputId = useId();
  const hintId = useId();
  const messageId = useId();

  const submitting = outcome.kind === "submitting";
  const account = state.status === "ok" && state.data.connected ? state.data : null;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const parsed = connectSoundcloudRequestSchema.safeParse({ token });
    if (!parsed.success) {
      setOutcome({
        kind: "error",
        message: parsed.error.issues[0]?.message ?? "Paste the oauth_token value.",
      });
      return;
    }

    setOutcome({ kind: "submitting" });
    const result = await submitToken(parsed.data.token);
    if (!result.ok) {
      setOutcome({ kind: "error", message: result.message });
      return;
    }
    setToken("");
    setOutcome({ kind: "connected", username: result.account.username });
    refresh();
  }

  return (
    <section aria-labelledby="paste-heading">
      <SectionLabel id="paste-heading">Paste it here</SectionLabel>

      {state.status === "loading" && (
        <div
          role="status"
          aria-label="Checking for a connected account"
          className="mb-4 h-[3.75rem] rounded-panel border border-border bg-surface-1"
        />
      )}
      {state.status === "error" && (
        <div className="mb-4">
          <ErrorState
            title="Could not check for a connected account"
            error={state.error}
            onRetry={reload}
          />
        </div>
      )}
      {account !== null && <ConnectedPanel account={account} />}

      <form
        onSubmit={(event) => void handleSubmit(event)}
        noValidate
        className="grid gap-3 rounded-panel border border-border bg-surface-1 px-4 py-4"
      >
        <div className="grid gap-2">
          <Label htmlFor={inputId}>
            {account === null
              ? "oauth_token value"
              : "Replace the token (to switch account or renew it)"}
          </Label>
          <Input
            id={inputId}
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="2-…"
            className="font-mono text-13"
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              if (!submitting) setOutcome({ kind: "idle" });
            }}
            disabled={submitting}
            aria-invalid={outcome.kind === "error"}
            aria-describedby={`${hintId} ${messageId}`}
          />
          <p id={hintId} className="text-xs text-text-muted">
            What you paste stays hidden. It is checked with SoundCloud before anything is saved.
          </p>
          <div id={messageId} aria-live="polite" className="min-h-5 text-13">
            {outcome.kind === "error" && (
              <p role="alert" className="text-danger">
                {outcome.message}
              </p>
            )}
            {submitting && <p className="text-text-muted">Checking the token with SoundCloud…</p>}
            {outcome.kind === "connected" && (
              <p className="text-ok">Connected as {outcome.username}.</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant={account === null ? "primary" : "secondary"}
            disabled={submitting || token.trim() === ""}
          >
            {submitting ? "Checking…" : account === null ? "Connect" : "Replace token"}
          </Button>
          {account === null && (
            <Link
              href="/playlists"
              className="text-13 text-text-muted underline-offset-2 hover:text-text hover:underline"
            >
              Skip for now
            </Link>
          )}
        </div>
        {account === null && (
          <p className="text-xs text-text-muted">
            Skipping is fine for adding playlists and reading the buy and manual lists. Downloads
            ask for this first.
          </p>
        )}
      </form>
    </section>
  );
}
