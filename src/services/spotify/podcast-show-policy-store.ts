import { prisma } from "@/lib/prisma";

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
>;

/**
 * Persistent product policy only. Traversal/shuffle consumption is deliberately
 * reconstructed from successful, non-simulation GenerationItem audit history so
 * merely simulating or collecting candidates can never advance a show.
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
    select: { id: true },
  });
  if (!source) return false;

  const maxReleaseAgeDays = normalizeNullableNonNegativeInt(
    input.maxReleaseAgeDays,
  );
  const maxEpisodesPerCycle = normalizeNullablePositiveInt(
    input.maxEpisodesPerCycle,
  );
  const startEpisodeId = normalizedId(input.startEpisodeId);
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
 * state and the user's library are untouched.
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
    randomRound: 0,
  };
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
