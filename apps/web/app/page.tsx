import { getSoundcloudAccount } from "@gatecrusher/db";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { homeDestination } from "@/lib/home-destination";
import { getLogger } from "@/lib/logger";

// Decided per visit: whether a SoundCloud account is connected changes at runtime.
export const dynamic = "force-dynamic";

export default async function HomePage(): Promise<never> {
  redirect(await homeDestination(() => getSoundcloudAccount(getDb().db), getLogger()));
}
