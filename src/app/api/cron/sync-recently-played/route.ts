import { NextResponse } from "next/server";

import { runRecentlyPlayedSync } from "@/jobs/sync-recently-played";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Read-only Spotify maintenance endpoint for MUSIC-01:
 *
 *   curl -fsS -X POST https://<host>/api/cron/sync-recently-played \
 *        -H "Authorization: Bearer $CRON_SECRET"
 *
 * It writes only the Sonoriza playback-history tables; no Spotify playlist is
 * created, replaced or mutated by this endpoint.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runRecentlyPlayedSync();
  return NextResponse.json(result);
}
