import type { Metadata } from "next";
import { ConnectSoundcloudForm } from "@/components/connect-soundcloud-form";
import { ConnectTutorial } from "@/components/connect-tutorial";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "Connect SoundCloud" };

export default function ConnectPage() {
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Connect SoundCloud"
        description="SoundCloud only hands an uploader's original file to a signed-in account. Gatecrusher signs in with a login token you copy from your browser; it never sees your password."
      />
      <ConnectTutorial />
      <ConnectSoundcloudForm />
    </div>
  );
}
