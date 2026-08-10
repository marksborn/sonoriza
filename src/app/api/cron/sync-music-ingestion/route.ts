import { NextResponse } from "next/server";

import { runMusicIngestionJob } from "@/jobs/sync-music-ingestion";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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

  return NextResponse.json(await runMusicIngestionJob());
}