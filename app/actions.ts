"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { refreshSnapshot } from "@/lib/snapshot";
import { SHOPIFY_FETCH_TAG } from "@/lib/shopify";

/**
 * "Refresh now" handler for the dashboard. Runs server-side and is gated by the
 * auth middleware (session cookie), so it does NOT need REFRESH_SECRET — that
 * secret is only for external/unauthenticated callers of /api/refresh.
 *
 * Busts the no-KV fallback fetch cache and recomputes the snapshot.
 */
export async function refreshNowAction(): Promise<void> {
  revalidateTag(SHOPIFY_FETCH_TAG);
  await refreshSnapshot();
  revalidatePath("/");
}
