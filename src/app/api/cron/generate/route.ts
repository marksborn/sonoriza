import { NextResponse } from "next/server";

import { runScheduledGeneration } from "@/jobs/scheduled-generation";
import { retryDuePushDeliveries } from "@/services/notifications";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

// The scheduled generation can be slow (many API calls); never cache it and
// allow a generous execution window.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Triggered by the server cron (CloudPanel / crontab):
 *
 *   curl -fsS -X POST https://<host>/api/cron/generate \
 *        -H "Authorization: Bearer $CRON_SECRET"
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Push retries are independent from Spotify. Run them on the same dispatcher
  // cadence before checking Spotify backoff, while preserving the existing
  // response contract and generation semantics.
  await retryDuePushDeliveries();

  const backoff = await getActiveSpotifyBackoff();
  if (backoff) {
    return NextResponse.json({
      skipped: true,
      reason: "SPOTIFY_BACKOFF_ACTIVE",
      spotifyBackoff: spotifyBackoffApiPayload(backoff),
    });
  }

  const result = await runScheduledGeneration();
  return NextResponse.json(result);
}
