import { prisma } from "@/lib/prisma";

import type { PodcastShowPolicySnapshot } from "./podcast-show-policy-store";

export type PodcastShowPolicyRuntimeSnapshot = PodcastShowPolicySnapshot & {
  /**
   * Real (non-simulation) SHOW selections published after the last policy save
   * or explicit reset, ordered exactly by run + target priority + item position.
   * This is the durable Sonoriza memory for replay traversal and shuffle rounds.
   */
  publishedEpisodeIds: string[];
};

type PublishedEpisodeRow = {
  sourcePlaylistId: string;
  spotifyUri: string;
};

/**
 * Reuses GenerationItem as the audit source of truth instead of advancing a
 * cursor during collection. That distinction is important: simulations and
 * candidates that were planned but never written must not consume a sequence or
 * a no-replacement shuffle slot.
 */
export async function hydratePodcastShowPolicyHistory(
  userId: string,
  policies: ReadonlyMap<string, PodcastShowPolicySnapshot>,
): Promise<Map<string, PodcastShowPolicyRuntimeSnapshot>> {
  if (policies.size === 0) return new Map();

  const rows = await prisma.$queryRaw<PublishedEpisodeRow[]>`
    SELECT
      s."id" AS "sourcePlaylistId",
      gi."spotifyUri"
    FROM "PodcastShowPolicy" p
    JOIN "SourcePlaylist" s
      ON s."id" = p."sourcePlaylistId"
    JOIN "GenerationItem" gi
      ON gi."sourceSpotifyType"::text = 'SHOW'
     AND gi."sourceSpotifyId" = s."spotifyId"
     AND gi."contentType"::text = 'PODCAST'
    JOIN "GenerationRun" gr
      ON gr."id" = gi."runId"
    JOIN "TargetPlaylist" t
      ON t."id" = gi."targetPlaylistId"
    WHERE s."userId" = ${userId}
      AND gr."userId" = ${userId}
      AND gr."simulation" = false
      AND gr."status"::text IN ('SUCCESS', 'PARTIAL')
      AND gr."startedAt" >= p."updatedAt"
    ORDER BY gr."startedAt" ASC, t."priority" ASC, gi."position" ASC
  `;

  const publishedBySource = new Map<string, string[]>();
  for (const row of rows) {
    const episodeId = spotifyEpisodeIdFromUri(row.spotifyUri);
    if (!episodeId) continue;
    const current = publishedBySource.get(row.sourcePlaylistId) ?? [];
    current.push(episodeId);
    publishedBySource.set(row.sourcePlaylistId, current);
  }

  return new Map(
    [...policies.entries()].map(([sourcePlaylistId, policy]) => [
      sourcePlaylistId,
      {
        ...policy,
        publishedEpisodeIds: publishedBySource.get(sourcePlaylistId) ?? [],
      },
    ]),
  );
}

function spotifyEpisodeIdFromUri(uri: string): string | null {
  const match = /^spotify:episode:([^:]+)$/.exec(uri.trim());
  return match?.[1] ?? null;
}
