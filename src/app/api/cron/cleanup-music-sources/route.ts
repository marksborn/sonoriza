import { NextResponse } from "next/server";

import { runMusicSourceCleanupJob } from "@/jobs/cleanup-music-sources";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * MUSIC-02 periodic maintenance endpoint.
 *
 * It may mutate Spotify source playlists, but only sources that have BOTH:
 * - an already completed first manual cleanup; and
 * - periodic automation explicitly enabled.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runMusicSourceCleanupJob();
  return NextResponse.json(result);
}
