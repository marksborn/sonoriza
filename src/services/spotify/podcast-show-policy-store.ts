import { prisma } from "@/lib/prisma";

import {
  DEFAULT_PODCAST_SHOW_PRIORITY,
  normalizePodcastShowCadence,
  type PodcastCadenceUnitValue,
  type PodcastShowPriorityValue,
} from "./podcast-show-cadence-contract";
import {
  loadPodcastShowCadencePolicies,
  podcastShowCadencePolicyUpdateRequested,
  resolvePodcastShowCadencePolicyUpdate,
  type PodcastShowCadencePolicySnapshot as GlobalPodcastShowCadencePolicySnapshot,
} from "./podcast-show-cadence-policy-store";

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

/**
 * Planner-facing PODCAST-05 policy. PODCAST-06 Gate 3 deliberately does not
 * widen this contract, so cadence/priority still cannot influence selection.
 */
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

export type PodcastShowCadencePolicySnapshot = Pick<
  GlobalPodcastShowCadencePolicySnapshot,
  "cadenceMaxEpisodes" | "cadenceUnit" | "priority"
>;

/**
 * Read-model used by the existing explicit-SHOW UI. PODCAST-05 remains
 * source-local, while PODCAST-06 cadence/priority are joined by spotifyShowId.
 */
export type PodcastShowPolicyStoredSnapshot = PodcastShowPolicySnapshot &
  PodcastShowCadencePolicySnapshot;

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
  Partial<PodcastShowCadencePolicySnapshot>;

/**
 * PODCAST-05 traversal policy is loaded only for explicit SHOW sources.
 * PODCAST-06 cadence/priority are source-independent and joined by Spotify show
 * identity from PodcastShowCadencePolicy. The planner-facing snapshot remains
 * narrower, so Gate 3 is persistence/read-model only.
 */
export async function loadPodcastShowPolicies(
  userId: string,
): Promise<Map<string, PodcastShowPolicyStoredSnapshot>> {
  const [sources, cadencePolicies] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
      },
      select: {
        id: true,
        spotifyId: true,
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
    }),
    loadPodcastShowCadencePolicies(userId),
  ]);

  return new Map(
    sources.map((source) => {
      const policy = source.podcastShowPolicy;
      const base: PodcastShowPolicySnapshot = policy
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
      const cadence = cadencePolicies.get(source.spotifyId);
      const snapshot: PodcastShowPolicyStoredSnapshot = {
        ...base,
        cadenceMaxEpisodes: cadence?.cadenceMaxEpisodes ?? null,
        cadenceUnit: cadence?.cadenceUnit ?? null,
        priority: cadence?.priority ?? DEFAULT_PODCAST_SHOW_PRIORITY,
      };
      return [source.id, snapshot] as const;
    }),
  );
}

export async function savePodcastShowPolicy(
  userId: string,
  sourcePlaylistId: string,
  input: PodcastShowPolicyUpdate,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const source = await tx.sourcePlaylist.findFirst({
      where: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
      },
      select: {
        id: true,
        spotifyId: true,
        name: true,
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
    const updatedAt = new Date();

    await tx.podcastShowPolicy.upsert({
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
    });

    // Keep legacy PODCAST-03 flags coherent for readers/UI that still consume
    // SourcePlaylist. These are unrelated to PODCAST-06 cadence authority.
    await tx.sourcePlaylist.update({
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
    });

    if (podcastShowCadencePolicyUpdateRequested(input)) {
      const existingRow = await tx.podcastShowCadencePolicy.findUnique({
        where: {
          userId_spotifyShowId: {
            userId,
            spotifyShowId: source.spotifyId,
          },
        },
        select: {
          spotifyShowId: true,
          showName: true,
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          priority: true,
        },
      });
      const existing: GlobalPodcastShowCadencePolicySnapshot | null = existingRow
        ? {
            spotifyShowId: existingRow.spotifyShowId,
            showName: existingRow.showName,
            ...normalizePodcastShowCadence({
              cadenceMaxEpisodes: existingRow.cadenceMaxEpisodes,
              cadenceUnit: existingRow.cadenceUnit,
            }),
            priority: existingRow.priority,
          }
        : null;
      const resolved = resolvePodcastShowCadencePolicyUpdate(
        source.spotifyId,
        existing,
        {
          showName: source.name,
          cadenceMaxEpisodes: input.cadenceMaxEpisodes,
          cadenceUnit: input.cadenceUnit,
          priority: input.priority,
        },
      );

      await tx.podcastShowCadencePolicy.upsert({
        where: {
          userId_spotifyShowId: {
            userId,
            spotifyShowId: source.spotifyId,
          },
        },
        create: {
          userId,
          spotifyShowId: source.spotifyId,
          showName: resolved.showName,
          cadenceMaxEpisodes: resolved.cadenceMaxEpisodes,
          cadenceUnit: resolved.cadenceUnit,
          priority: resolved.priority,
        },
        update: {
          showName: resolved.showName,
          cadenceMaxEpisodes: resolved.cadenceMaxEpisodes,
          cadenceUnit: resolved.cadenceUnit,
          priority: resolved.priority,
        },
      });
    }

    return true;
  });
}

/**
 * Reset remains PODCAST-05-local. It changes traversal history only and never
 * touches the source-independent PODCAST-06 cadence/priority row.
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
