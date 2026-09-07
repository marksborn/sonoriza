import { prisma } from "@/lib/prisma";

import {
  DEFAULT_PODCAST_SHOW_PRIORITY,
  normalizePodcastShowCadence,
  type PodcastCadenceUnitValue,
  type PodcastShowPriorityValue,
} from "./podcast-show-cadence-contract";

export type { PodcastCadenceUnitValue, PodcastShowPriorityValue };

export type PodcastEpisodeEligibilityValue =
  | "UNPLAYED_ONLY"
  | "PLAYED_ONLY"
  | "ALL";
export type PodcastShowOrderValue =
  | "OLDEST_FIRST"
  | "NEWEST_FIRST"
  | "RANDOM";
export type PodcastRandomPolicyValue =
  | "WITHOUT_REPLACEMENT"
  | "WITH_REPLACEMENT";
export type PodcastExpiryPolicyValue =
  | "STRICT_EXPIRY"
  | "ALLOW_IN_PROGRESS_TO_FINISH";

export type PodcastShowPolicySnapshot = {
  sourcePlaylistId: string;
  episodeEligibility: PodcastEpisodeEligibilityValue;
  episodeOrder: PodcastShowOrderValue;
  randomPolicy: PodcastRandomPolicyValue;
  startEpisodeId: string | null;
  strictSequence: boolean;
  maxReleaseAgeDays: number | null;
  expiryPolicy: PodcastExpiryPolicyValue;
  maxEpisodesPerCycle: number | null;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastCadenceUnitValue | null;
  priority: PodcastShowPriorityValue;
  /** Reset generation used only to rotate the deterministic random seed. */
  randomRound: number;
  /** Deprecated compatibility fields: published GenerationItems are authoritative. */
  sequenceCursorEpisodeId?: string | null;
  sequenceCompleted?: boolean;
  randomConsumedEpisodeIds?: string[];
};

export type PodcastShowPolicyUpdate = Pick<
  PodcastShowPolicySnapshot,
  | "episodeEligibility"
  | "episodeOrder"
  | "randomPolicy"
  | "startEpisodeId"
  | "strictSequence"
  | "maxReleaseAgeDays"
  | "expiryPolicy"
  | "maxEpisodesPerCycle"
> &
  Partial<
    Pick<
      PodcastShowPolicySnapshot,
      "cadenceMaxEpisodes" | "cadenceUnit" | "priority"
    >
  >;

/**
 * Persistent product policy only. Traversal/shuffle consumption is deliberately
 * reconstructed from successful, non-simulation GenerationItem audit history so
 * merely simulating or collecting candidates can never advance a show.
 *
 * PODCAST-06 cadence configuration is persisted here as product policy, but
 * Gate 1 deliberately does not apply it to planner candidates. Future cadence
 * consumption is derived from EpisodeListeningState.firstProgressObservedAt.
 */
export async function loadPodcastShowPolicies(
  userId: string,
): Promise<Map<string, PodcastShowPolicySnapshot>> {
  const sources = await prisma.sourcePlaylist.findMany({
    where: {
      userId,
      kind: "PODCAST",
      spotifyType: "SHOW",
    },
    select: {
      id: true,
      includePlayed: true,
      episodeOrder: true,
      podcastShowPolicy: {
        select: {
          episodeEligibility: true,
          episodeOrder: true,
          randomPolicy: true,
          startEpisodeId: true,
          strictSequence: true,
          maxReleaseAgeDays: true,
          expiryPolicy: true,
          maxEpisodesPerCycle: true,
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
          randomRound: true,
        },
      },
    },
  });

  return new Map(
    sources.map((source) => {
      const policy = source.podcastShowPolicy;
      const snapshot: PodcastShowPolicySnapshot = policy
        ? {
            sourcePlaylistId: source.id,
            episodeEligibility: policy.episodeEligibility,
            episodeOrder: policy.episodeOrder,
            randomPolicy: policy.randomPolicy,
            startEpisodeId: normalizedId(policy.startEpisodeId),
            strictSequence: policy.strictSequence,
            maxReleaseAgeDays: normalizeNullableNonNegativeInt(
              policy.maxReleaseAgeDays,
            ),
            expiryPolicy: policy.expiryPolicy,
            maxEpisodesPerCycle: normalizeNullablePositiveInt(
              policy.maxEpisodesPerCycle,
            ),
            ...normalizePodcastShowCadence({
              cadenceMaxEpisodes: policy.cadenceMaxEpisodes,
              cadenceUnit: policy.cadenceUnit,
            }),
            priority: policy.priority,
            randomRound: Math.max(0, Math.trunc(policy.randomRound)),
          }
        : legacyPolicy({
            sourcePlaylistId: source.id,
            includePlayed: source.includePlayed,
            episodeOrder: source.episodeOrder,
          });
      return [source.id, snapshot] as const;
    }),
  );
}

export async function savePodcastShowPolicy(
  userId: string,
  sourcePlaylistId: string,
  input: PodcastShowPolicyUpdate,
): Promise<boolean> {
  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id: sourcePlaylistId,
      userId,
      kind: "PODCAST",
      spotifyType: "SHOW",
    },
    select: {
      id: true,
      podcastShowPolicy: {
        select: {
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
        },
      },
    },
  });
  if (!source) return false;

  const maxReleaseAgeDays = normalizeNullableNonNegativeInt(
    input.maxReleaseAgeDays,
  );
  const maxEpisodesPerCycle = normalizeNullablePositiveInt(
    input.maxEpisodesPerCycle,
  );
  const startEpisodeId = normalizedId(input.startEpisodeId);
  const cadence = resolveCadenceUpdate(input, source.podcastShowPolicy);
  const priority =
    input.priority ??
    source.podcastShowPolicy?.priority ??
    DEFAULT_PODCAST_SHOW_PRIORITY;
  const updatedAt = new Date();

  await prisma.$transaction([
    prisma.podcastShowPolicy.upsert({
      where: { sourcePlaylistId },
      create: {
        sourcePlaylistId,
        episodeEligibility: input.episodeEligibility,
        episodeOrder: input.episodeOrder,
        randomPolicy: input.randomPolicy,
        startEpisodeId,
        strictSequence: input.strictSequence,
        maxReleaseAgeDays,
        expiryPolicy: input.expiryPolicy,
        maxEpisodesPerCycle,
        cadenceMaxEpisodes: cadence.cadenceMaxEpisodes,
        cadenceUnit: cadence.cadenceUnit,
        priority,
        randomRound: 0,
        randomConsumedEpisodeIds: [],
        updatedAt,
      },
      update: {
        episodeEligibility: input.episodeEligibility,
        episodeOrder: input.episodeOrder,
        randomPolicy: input.randomPolicy,
        startEpisodeId,
        strictSequence: input.strictSequence,
        maxReleaseAgeDays,
        expiryPolicy: input.expiryPolicy,
        maxEpisodesPerCycle,
        cadenceMaxEpisodes: cadence.cadenceMaxEpisodes,
        cadenceUnit: cadence.cadenceUnit,
        priority,
        sequenceCursorEpisodeId: null,
        sequenceCompleted: false,
        randomRound: { increment: 1 },
        randomConsumedEpisodeIds: [],
        updatedAt,
      },
    }),
    // Keep legacy flags coherent for readers/UI that still consume PODCAST-03.
    prisma.sourcePlaylist.update({
      where: { id: sourcePlaylistId },
      data: {
        includePlayed: input.episodeEligibility !== "UNPLAYED_ONLY",
        episodeOrder:
          input.episodeOrder === "NEWEST_FIRST"
            ? "NEWEST_FIRST"
            : input.episodeOrder === "OLDEST_FIRST"
              ? "OLDEST_FIRST"
              : "SOURCE_DEFAULT",
      },
    }),
  ]);

  return true;
}

/**
 * Reset is a policy-local operation: changing updatedAt makes all older real
 * GenerationItems fall outside the traversal-history window. Spotify playback
 * state and the user's library are untouched. PODCAST-06 cadence/priority are
 * product configuration and therefore remain unchanged by a progress reset.
 */
export async function resetPodcastShowPolicyProgress(
  userId: string,
  sourcePlaylistId: string,
): Promise<boolean> {
  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id: sourcePlaylistId,
      userId,
      kind: "PODCAST",
      spotifyType: "SHOW",
    },
    select: {
      id: true,
      includePlayed: true,
      episodeOrder: true,
    },
  });
  if (!source) return false;

  const fallback = legacyPolicy({
    sourcePlaylistId,
    includePlayed: source.includePlayed,
    episodeOrder: source.episodeOrder,
  });
  const updatedAt = new Date();

  await prisma.podcastShowPolicy.upsert({
    where: { sourcePlaylistId },
    create: {
      sourcePlaylistId,
      episodeEligibility: fallback.episodeEligibility,
      episodeOrder: fallback.episodeOrder,
      randomPolicy: fallback.randomPolicy,
      strictSequence: fallback.strictSequence,
      maxReleaseAgeDays: fallback.maxReleaseAgeDays,
      expiryPolicy: fallback.expiryPolicy,
      maxEpisodesPerCycle: fallback.maxEpisodesPerCycle,
      cadenceMaxEpisodes: fallback.cadenceMaxEpisodes,
      cadenceUnit: fallback.cadenceUnit,
      priority: fallback.priority,
      randomRound: 1,
      randomConsumedEpisodeIds: [],
      updatedAt,
    },
    update: {
      sequenceCursorEpisodeId: null,
      sequenceCompleted: false,
      randomRound: { increment: 1 },
      randomConsumedEpisodeIds: [],
      updatedAt,
    },
  });

  return true;
}

function legacyPolicy(input: {
  sourcePlaylistId: string;
  includePlayed: boolean;
  episodeOrder: string;
}): PodcastShowPolicySnapshot {
  return {
    sourcePlaylistId: input.sourcePlaylistId,
    episodeEligibility: input.includePlayed ? "ALL" : "UNPLAYED_ONLY",
    episodeOrder:
      input.episodeOrder === "NEWEST_FIRST" ? "NEWEST_FIRST" : "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: null,
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
    priority: DEFAULT_PODCAST_SHOW_PRIORITY,
    randomRound: 0,
  };
}

function resolveCadenceUpdate(
  input: Pick<
    PodcastShowPolicyUpdate,
    "cadenceMaxEpisodes" | "cadenceUnit"
  >,
  existing: {
    cadenceMaxEpisodes: number | null;
    cadenceUnit: PodcastCadenceUnitValue | null;
  } | null,
) {
  const cadenceMaxEpisodes =
    input.cadenceMaxEpisodes === undefined
      ? existing?.cadenceMaxEpisodes ?? null
      : input.cadenceMaxEpisodes;
  const cadenceUnit =
    input.cadenceUnit === undefined
      ? existing?.cadenceUnit ?? null
      : input.cadenceUnit;

  return normalizePodcastShowCadence({
    cadenceMaxEpisodes,
    cadenceUnit,
  });
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeNullablePositiveInt(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function normalizeNullableNonNegativeInt(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
