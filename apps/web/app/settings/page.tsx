import { ENV_VAR_DOCS, isEnvVarSet, type EnvVarDoc } from "@gatecrusher/core";
import { Check, Minus, X } from "lucide-react";
import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { SectionLabel } from "@/components/section-label";
import { SoundcloudAccountPanel } from "@/components/soundcloud-account-panel";

export const metadata: Metadata = { title: "Settings" };

// Read at request time, not baked in at build time.
export const dynamic = "force-dynamic";

type EnvStatus = "set" | "default" | "missing";

/** Only ever looks at whether a variable has a value, never at the value. */
function statusOf(doc: EnvVarDoc): EnvStatus {
  if (isEnvVarSet(process.env, doc.name)) return "set";
  return doc.required ? "missing" : "default";
}

function StatusCell({ status }: { status: EnvStatus }) {
  switch (status) {
    case "set":
      return (
        <span className="inline-flex items-center gap-1.5 text-ok">
          <Check className="size-4" aria-hidden="true" />
          Set
        </span>
      );
    case "default":
      return (
        <span className="inline-flex items-center gap-1.5 text-text-muted">
          <Minus className="size-4" aria-hidden="true" />
          Not set
        </span>
      );
    case "missing":
      return (
        <span className="inline-flex items-center gap-1.5 text-danger">
          <X className="size-4" aria-hidden="true" />
          Missing
        </span>
      );
  }
}

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="The SoundCloud account downloads run as, and the configuration from the .env file in the repo root. Secret values are never shown here."
      />

      <SoundcloudAccountPanel />

      <section aria-labelledby="env-heading">
        <SectionLabel id="env-heading">Environment</SectionLabel>
        <p className="mb-3 max-w-prose text-13 text-text-muted">
          As seen by the web app. The worker reads the same file when it starts, so worker-only
          variables show here too when web runs on the same machine.
        </p>

        <ul className="divide-y divide-border rounded-panel border border-border bg-surface-1">
          {ENV_VAR_DOCS.map((doc) => (
            <li
              key={doc.name}
              className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-4 py-2.5 lg:grid-cols-[16rem_1fr_11rem_6rem] lg:items-center"
            >
              <span className="truncate font-mono text-13 text-text" title={doc.name}>
                {doc.name}
              </span>
              <span className="text-13 lg:order-last lg:justify-self-end">
                <StatusCell status={statusOf(doc)} />
              </span>
              <span className="col-span-2 text-13 text-text-muted lg:col-span-1">
                {doc.description}
              </span>
              <span className="col-span-2 text-xs text-text-muted lg:col-span-1">
                {doc.required ? "Required" : "Optional"} · {doc.usedBy.join(" + ")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
