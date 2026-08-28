import { NextResponse } from "next/server";

import { runLikedTrackIncrementalSyncJob } from "@/jobs/liked-track-incremental-sync";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * SOURCE-LIKED-01 Gate 4B dedicated cron endpoint.
 *
 * This route intentionally runs only the native Liked Tracks incremental sync.
 * It must stay separate from /api/cron/sync-music-ingestion so scheduling
 * Saved Tracks synchronization cannot implicitly execute MUSIC-03 inbox rules.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const backoff = await getActiveSpotifyBackoff();
  if (backoff) {
    return NextResponse.json({
      skipped: true,
      reason: "SPOTIFY_BACKOFF_ACTIVE",
      spotifyBackoff: spotifyBackoffApiPayload(backoff),
    });
  }

  return NextResponse.json(await runLikedTrackIncrementalSyncJob());
}
