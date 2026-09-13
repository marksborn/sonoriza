import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import type { ConfigurationAssessment } from "@/services/configuration-readiness";

export type Podcast07SavedEpisodesFingerprintPolicy = Readonly<{
  spotifyId: string;
  enabled: boolean;
  episodeOrder: "OLDEST_FIRST" | "NEWEST_FIRST" | "RANDOM";
  randomPolicy: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "WEEK" | null;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL";
}>;

export type Podcast07ShowFingerprintPolicy = Readonly<{
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

type SavedPolicyRow = Readonly<{
  enabled: boolean;
  episodeOrder: "OLDEST_FIRST" | "NEWEST_FIRST" | "RANDOM";
  randomPolicy: "WITHOUT_REPLACEMENT" | "WITH_REPLACEMENT";
  cadenceMaxEpisodes: number | null;
  cadenceUnit: "DAY" | "WEEK" | "MONTH" | null;
  frequencyScope: "PER_SHOW" | "GLOBAL_POOL";
}>;

function neutralSavedPolicy(spotifyId: string): Podcast07SavedEpisodesFingerprintPolicy {
  return {
    spotifyId,
    enabled: false,
    episodeOrder: "RANDOM",
    randomPolicy: "WITH_REPLACEMENT",
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
    frequencyScope: "PER_SHOW",
  };
}

function effectiveSavedPolicy(
  spotifyId: string,
  row: SavedPolicyRow | undefined,
): Podcast07SavedEpisodesFingerprintPolicy {
  if (!row?.enabled) return neutralSavedPolicy(spotifyId);

  const cadenceConfigured =
    row.cadenceMaxEpisodes !== null && row.cadenceUnit === "WEEK";
  return {
    spotifyId,
    enabled: true,
    episodeOrder: row.episodeOrder,
    randomPolicy:
      row.episodeOrder === "RANDOM"
        ? row.randomPolicy
        : "WITHOUT_REPLACEMENT",
    cadenceMaxEpisodes: cadenceConfigured ? row.cadenceMaxEpisodes : null,
    cadenceUnit: cadenceConfigured ? "WEEK" : null,
    frequencyScope: cadenceConfigured ? row.frequencyScope : "PER_SHOW",
  };
}

/**
 * PODCAST-07 Gate 6 fingerprint decorator.
 *
 * Only effective, plan-affecting configuration participates. Runtime memory
 * such as random round/cursors and factual listening state intentionally stay
 * out of CONFIG-04. A disabled or absent SAVED_EPISODES policy normalizes to
 * the same neutral value, and irrelevant conditional fields are normalized so
 * cosmetic/stale values do not invalidate a simulation.
 *
 * PODCAST-06 cadence/priority remains canonical in PodcastShowCadencePolicy and
 * already participates in the base CONFIG-04 fingerprint. This decorator adds
 * the PODCAST-07 dimensions that were previously missing: SAVED_EPISODES
 * defaults, inheritance authority, SHOW traversal policy and showEpisodeScope.
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
          where: { sourcePlaylistId: { in: sourceIds } },
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
    .map((source) =>
      effectiveSavedPolicy(source.spotifyId, savedBySource.get(source.id)),
    )
    .sort((left, right) => left.spotifyId.localeCompare(right.spotifyId));

  const shows: Podcast07ShowFingerprintPolicy[] = podcastSources
    .filter((source) => source.spotifyType === "SHOW")
    .map((source) => {
      const row = showBySource.get(source.id);
      if (!row) {
        return {
          spotifyShowId: source.spotifyId,
          authority: "INHERIT_SAVED_EPISODES" as const,
          policy: null,
        };
      }

      const random = row.episodeOrder === "RANDOM";
      const hasExpiry = row.maxReleaseAgeDays !== null;
      return {
        spotifyShowId: source.spotifyId,
        authority: "SHOW_OVERRIDE" as const,
        policy: {
          episodeEligibility: row.episodeEligibility,
          episodeOrder: row.episodeOrder,
          randomPolicy: random
            ? row.randomPolicy
            : "WITHOUT_REPLACEMENT",
          showEpisodeScope: row.showEpisodeScope,
          startEpisodeId: random ? null : row.startEpisodeId,
          strictSequence: random ? false : row.strictSequence,
          maxReleaseAgeDays: row.maxReleaseAgeDays,
          expiryPolicy: hasExpiry
            ? row.expiryPolicy
            : "STRICT_EXPIRY",
          maxEpisodesPerCycle: row.maxEpisodesPerCycle,
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
  const hasEffectivePodcast07Configuration =
    snapshot.savedEpisodes.some((policy) => policy.enabled) ||
    snapshot.shows.some((show) => show.authority === "SHOW_OVERRIDE");

  // Preserve existing CONFIG-04 evidence when PODCAST-07 is completely neutral.
  // Deploying Gate 6 alone must not invalidate simulations for users who have
  // not enabled the SAVED_EPISODES default and have no explicit SHOW override.
  if (!hasEffectivePodcast07Configuration) return baseFingerprint;

  return createHash("sha256")
    .update(
      JSON.stringify({
        baseFingerprint,
        podcast07: {
          savedEpisodes: [...snapshot.savedEpisodes].sort((left, right) =>
            left.spotifyId.localeCompare(right.spotifyId),
          ),
          shows: [...snapshot.shows].sort((left, right) =>
            left.spotifyShowId.localeCompare(right.spotifyShowId),
          ),
        },
      }),
    )
    .digest("hex");
}
