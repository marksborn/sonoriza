import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { getAlbumUiSnapshot } from "@/services/album-discovery/ui-snapshot";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Warms the persistent Next data cache used by Descobrir > Álbuns.
 * Suggested server cadence: every 5 minutes. The underlying snapshot has a
 * 30-minute revalidation window, so most cron calls are cache hits and do not
 * touch Spotify.
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

  const users = await prisma.user.findMany({
    where: {
      accounts: {
        some: { provider: "spotify" },
      },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });

  const results: Array<{
    userId: string;
    status: "READY" | "FAILED";
    generatedAt?: string;
    recommendationCount?: number;
    error?: string;
  }> = [];

  for (const user of users) {
    try {
      const snapshot = await getAlbumUiSnapshot(user.id);
      results.push({
        userId: user.id,
        status: "READY",
        generatedAt: snapshot.generatedAt,
        recommendationCount: snapshot.recommendations.length,
      });
    } catch (error) {
      results.push({
        userId: user.id,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return NextResponse.json({
    skipped: false,
    userCount: users.length,
    readyCount: results.filter((result) => result.status === "READY").length,
    failedCount: results.filter((result) => result.status === "FAILED").length,
    results,
  });
}
