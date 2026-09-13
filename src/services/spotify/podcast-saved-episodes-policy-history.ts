import { prisma } from "@/lib/prisma";

export type PodcastSavedEpisodesPublishedHistory = ReadonlyMap<
  string,
  readonly string[]
>;

type PublishedEpisodeRow = {
  spotifyShowId: string;
  spotifyUri: string;
};

/**
 * Durable shuffle memory for PODCAST-07 defaults.
 *
 * Only successful/partial real generations after the default policy was last
 * saved count as published traversal. Simulations never advance a random round.
 * SAVED_ONLY overrides are intentionally absent because Gate 7 attributes them
 * to SHOW, where PODCAST-05 already owns the publication history.
 */
export async function loadPodcastSavedEpisodesPublishedHistory(
  userId: string,
  sourcePlaylistId: string,
): Promise<PodcastSavedEpisodesPublishedHistory> {
  const rows = await prisma.$queryRaw<PublishedEpisodeRow[]>`
    SELECT
      gi."programId" AS "spotifyShowId",
      gi."spotifyUri"
    FROM "PodcastSavedEpisodesPolicy" p
    JOIN "SourcePlaylist" s
      ON s."id" = p."sourcePlaylistId"
    JOIN "GenerationItem" gi
      ON gi."sourceSpotifyType"::text = 'SAVED_EPISODES'
     AND gi."sourceSpotifyId" = s."spotifyId"
     AND gi."contentType"::text = 'PODCAST'
     AND gi."programId" IS NOT NULL
    JOIN "GenerationRun" gr
      ON gr."id" = gi."runId"
    JOIN "TargetPlaylist" t
      ON t."id" = gi."targetPlaylistId"
    WHERE p."sourcePlaylistId" = ${sourcePlaylistId}
      AND s."userId" = ${userId}
      AND gr."userId" = ${userId}
      AND gr."simulation" = false
      AND gr."status"::text IN ('SUCCESS', 'PARTIAL')
      AND gr."startedAt" >= p."updatedAt"
    ORDER BY gr."startedAt" ASC, t."priority" ASC, gi."position" ASC
  `;

  const byShow = new Map<string, string[]>();
  for (const row of rows) {
    const showId = normalizedText(row.spotifyShowId);
    const episodeId = spotifyEpisodeIdFromUri(row.spotifyUri);
    if (!showId || !episodeId) continue;
    const published = byShow.get(showId) ?? [];
    published.push(episodeId);
    byShow.set(showId, published);
  }
  return byShow;
}

function spotifyEpisodeIdFromUri(uri: string): string | null {
  const match = /^spotify:episode:([^:]+)$/.exec(uri.trim());
  return match?.[1] ?? null;
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
