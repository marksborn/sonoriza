import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import type { ConfigurationAssessment } from "@/services/configuration-readiness";

export type Podcast07SavedEpisodesFingerprintPolicy = Readonly<{
  sourcePlaylistId: string;
  spotifyId: string;
  enabled: boolean;
  episodeOrder: "OLDEST_FIRST" | "NEWEST_FIRST" | "RANDOM";
  randomPolicy: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "WEEK" | null;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL";
}>;

export type Podcast07ShowFingerprintPolicy = Readonly<{
  sourcePlaylistId: string;
  spotifyShowId: string;
  authority: "INHERIT_SAVED_EPISODES" | "SHOW_OVERRIDE";
  policy: null | Readonly<{
    episodeEligibility: "UNPLAYED_ONLY" | "PLAYED_ONLY" | "ALL";
    episodeOrder: "OLDEST_FIRST" | "NEWEST_FIRST" | "RANDOM";
    randomPolicy: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
    showEpisodeScope: "ALL_EPISODES" | "SAVED_ONLY";
    startEpisodeId: string | null;
    strictSequence: boolean;
    maxReleaseAgeDays: number | null;
    expiryPolicy: "STRICT_EXPIRY" | "ALLOW_IN_PROGRESS_TO_FINISH";
    maxEpisodesPerCycle: number | null;
    cadenceMaxEpisodes: number | null;
    cadenceUnit: "DAY" | "WEEK" | "MONTH" | null;
    priority: "NORMAL" | "PRIORITY";
  }>;
}>;

export type Podcast07FingerprintSnapshot = Readonly<{
  savedEpisodes: readonly Podcast07SavedEpisodesFingerprintPolicy[];
  shows: readonly Podcast07ShowFingerprintPolicy[];
}>;

export type Podcast07GenerationConfiguration = Readonly<{
  assessment: ConfigurationAssessment;
  fingerprintSnapshot: Podcast07FingerprintSnapshot;
}>;

const neutralSavedPolicy = (sourcePlaylistId: string, spotifyId: string) => ({
  sourcePlaylistId,
  spotifyId,
  enabled: false,
  episodeOrder: "RANDOM" as const,
  randomPolicy: "WITH_REPLACEMENT" as const,
  cadenceMaxEpisodes: null,
  cadenceUnit: null,
  frequencyScope: "PER_SHOW" as const,
});

/**
 * PODCAST-07 Gate 6 fingerprint decorator.
 *
 * Only plan-affecting configuration participates. Runtime memory such as random
 * round/cursors and factual listening state intentionally stay out of CONFIG-04.
 * Missing SAVED_EPISODES policy is normalized to the neutral persisted default,
 * while presence/absence of a SHOW policy remains explicit because it changes
 * authority (inheritance vs authoritative override).
 */
export async function assessPodcast07GenerationConfiguration(
  userId: string,
  baseAssessment: ConfigurationAssessment,
): Promise<Podcast07GenerationConfiguration> {
  const podcastSources = baseAssessment.sources.filter(
    (source) => source.kind === "PODCAST",
  );
  const sourceIds = podcastSources.map((source) => source.id);

  const [savedRows, showRows] = sourceIds.length === 0
    ? [[], []] as const
    : await Promise.all([
        prisma.podcastSavedEpisodesPolicy.findMany({
          where: { userId, sourcePlaylistId: { in: sourceIds } },
          select: {
            sourcePlaylistId: true,
            enabled: true,
            episodeOrder: true,
            randomPolicy: true,
            cadenceMaxEpisodes: true,
            cadenceUnit: true,
            frequencyScope: true,
          },
        }),
        prisma.podcastShowPolicy.findMany({
          where: { userId, sourcePlaylistId: { in: sourceIds } },
          select: {
            sourcePlaylistId: true,
            episodeEligibility: true,
            episodeOrder: true,
            randomPolicy: true,
            showEpisodeScope: true,
            startEpisodeId: true,
            strictSequence: true,
            maxReleaseAgeDays: true,
            expiryPolicy: true,
            maxEpisodesPerCycle: true,
            cadenceMaxEpisodes: true,
            cadenceUnit: true,
            priority: true,
          },
        }),
      ]);

  const savedBySource = new Map(
    savedRows.map((row) => [row.sourcePlaylistId, row] as const),
  );
  const showBySource = new Map(
    showRows.map((row) => [row.sourcePlaylistId, row] as const),
  );

  const savedEpisodes: Podcast07SavedEpisodesFingerprintPolicy[] = podcastSources
    .filter((source) => source.spotifyType === "SAVED_EPISODES")
    .map((source) => {
      const row = savedBySource.get(source.id);
      if (!row) return neutralSavedPolicy(source.id, source.spotifyId);
      return {
        sourcePlaylistId: source.id,
        spotifyId: source.spotifyId,
        enabled: row.enabled,
        episodeOrder: row.episodeOrder,
        randomPolicy: row.randomPolicy,
        cadenceMaxEpisodes: row.cadenceMaxEpisodes,
        cadenceUnit: row.cadenceUnit,
        frequencyScope: row.frequencyScope,
      };
    })
    .sort((left, right) => left.sourcePlaylistId.localeCompare(right.sourcePlaylistId));

  const shows: Podcast07ShowFingerprintPolicy[] = podcastSources
    .filter((source) => source.spotifyType === "SHOW")
    .map((source) => {
      const row = showBySource.get(source.id);
      if (!row) {
        return {
          sourcePlaylistId: source.id,
          spotifyShowId: source.spotifyId,
          authority: "INHERIT_SAVED_EPISODES" as const,
          policy: null,
        };
      }
      return {
        sourcePlaylistId: source.id,
        spotifyShowId: source.spotifyId,
        authority: "SHOW_OVERRIDE" as const,
        policy: {
          episodeEligibility: row.episodeEligibility,
          episodeOrder: row.episodeOrder,
          randomPolicy: row.randomPolicy,
          showEpisodeScope: row.showEpisodeScope,
          startEpisodeId: row.startEpisodeId,
          strictSequence: row.strictSequence,
          maxReleaseAgeDays: row.maxReleaseAgeDays,
          expiryPolicy: row.expiryPolicy,
          maxEpisodesPerCycle: row.maxEpisodesPerCycle,
          cadenceMaxEpisodes: row.cadenceMaxEpisodes,
          cadenceUnit: row.cadenceUnit,
          priority: row.priority,
        },
      };
    })
    .sort((left, right) => left.spotifyShowId.localeCompare(right.spotifyShowId));

  const fingerprintSnapshot = { savedEpisodes, shows };
  return {
    assessment: {
      ...baseAssessment,
      fingerprint: podcast07ConfigurationFingerprint(
        baseAssessment.fingerprint,
        fingerprintSnapshot,
      ),
    },
    fingerprintSnapshot,
  };
}

export function podcast07ConfigurationFingerprint(
  baseFingerprint: string,
  snapshot: Podcast07FingerprintSnapshot,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        baseFingerprint,
        podcast07: {
          savedEpisodes: [...snapshot.savedEpisodes].sort((left, right) =>
            left.sourcePlaylistId.localeCompare(right.sourcePlaylistId),
          ),
          shows: [...snapshot.shows].sort((left, right) =>
            left.spotifyShowId.localeCompare(right.spotifyShowId),
          ),
        },
      }),
    )
    .digest("hex");
}
