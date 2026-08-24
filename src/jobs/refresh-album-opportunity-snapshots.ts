import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import {
  getAlbumOpportunitySnapshotRefreshState,
  refreshAlbumOpportunitySnapshot,
} from "@/services/album-discovery/opportunity-snapshot";

export type AlbumOpportunitySnapshotRefreshJobResult = {
  processed: number;
  refreshed: number;
  skippedFresh: number;
  failed: number;
  results: Array<{
    userId: string;
    status: "refreshed" | "skipped_fresh" | "failed";
    generatedAt?: string;
    candidateCount?: number;
    persistedCandidateCount?: number;
    providerFailureCount?: number;
    ageMs?: number | null;
    error?: string;
  }>;
};

/**
 * Precomputes ALBUM-01 opportunity snapshots so Descobrir > Álbuns never has
 * to crawl the Spotify album catalog on the page request path.
 *
 * Spotify access is read-only. The job writes only the versioned local cache;
 * QUEUED memory and the controlled album writer remain separate authorities.
 */
export async function runAlbumOpportunitySnapshotRefresh(input: {
  force?: boolean;
  now?: Date;
} = {}): Promise<AlbumOpportunitySnapshotRefreshJobResult> {
  const now = input.now ?? new Date();
  const users = (
    await prisma.user.findMany({
      where: {
        accounts: {
          some: {
            provider: "spotify",
          },
        },
      },
      select: {
        id: true,
        email: true,
      },
      orderBy: { id: "asc" },
    })
  ).filter((user) => isEmailAllowed(user.email));

  const results: AlbumOpportunitySnapshotRefreshJobResult["results"] = [];

  for (const user of users) {
    try {
      const state = await getAlbumOpportunitySnapshotRefreshState(user.id, now);
      if (!input.force && !state.shouldRefresh) {
        results.push({
          userId: user.id,
          status: "skipped_fresh",
          generatedAt: state.generatedAt?.toISOString(),
          ageMs: state.ageMs,
        });
        continue;
      }

      const refreshed = await refreshAlbumOpportunitySnapshot(user.id, { asOf: now });
      results.push({
        userId: user.id,
        status: "refreshed",
        generatedAt: refreshed.generatedAt.toISOString(),
        candidateCount: refreshed.candidateCount,
        persistedCandidateCount: refreshed.persistedCandidateCount,
        providerFailureCount: refreshed.providerFailureCount,
      });
    } catch (error) {
      results.push({
        userId: user.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    processed: results.length,
    refreshed: results.filter((result) => result.status === "refreshed").length,
    skippedFresh: results.filter((result) => result.status === "skipped_fresh").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  };
}
