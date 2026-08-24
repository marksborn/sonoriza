import { NextResponse } from "next/server";

import { runAlbumOpportunitySnapshotRefresh } from "@/jobs/refresh-album-opportunity-snapshots";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Read-only Spotify maintenance endpoint for ALBUM-01 snapshots.
 *
 * The endpoint precomputes recommendation data outside the interactive page
 * request. It never mutates Spotify playlists. The only local write is the
 * atomic, versioned snapshot cache used by Descobrir > Álbuns.
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

  const result = await runAlbumOpportunitySnapshotRefresh();
  return NextResponse.json(result);
}
