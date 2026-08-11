import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { syncRecentlyPlayed } from "@/services/spotify/recently-played";

export type RecentPlaybackSyncJobResult = {
  processed: number;
  succeeded: number;
  failed: number;
  results: Array<{
    userId: string;
    status: "ok" | "failed";
    eventsRead?: number;
    identitiesUpdated?: number;
    error?: string;
  }>;
};

/**
 * Periodic MUSIC-01 maintenance. It reads Spotify Recently Played and updates
 * only the Sonoriza database; it never creates or modifies Spotify playlists.
 * AUTH-01 is applied before provider access so removed users stop consuming
 * Spotify quota in background jobs as well as interactive routes.
 */
export async function runRecentlyPlayedSync(): Promise<RecentPlaybackSyncJobResult> {
  const policies = (
    await prisma.musicPlaybackPolicy.findMany({
      where: { enabled: true },
      select: {
        userId: true,
        user: { select: { email: true } },
      },
      orderBy: { userId: "asc" },
    })
  ).filter((policy) => isEmailAllowed(policy.user.email));

  const results: RecentPlaybackSyncJobResult["results"] = [];
  for (const policy of policies) {
    try {
      const sync = await syncRecentlyPlayed(policy.userId, new Date());
      results.push({
        userId: policy.userId,
        status: "ok",
        eventsRead: sync.eventsRead,
        identitiesUpdated: sync.identitiesUpdated,
      });
    } catch (error) {
      results.push({
        userId: policy.userId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const succeeded = results.filter((result) => result.status === "ok").length;
  return {
    processed: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
