import { prisma } from "@/lib/prisma";

export type PodcastSavedEpisodesFrequencyScopeValue =
  | "PER_SHOW"
  | "GLOBAL_POOL";
export type PodcastSavedEpisodesOrderValue =
  | "OLDEST_FIRST"
  | "NEWEST_FIRST"
  | "RANDOM";
export type PodcastSavedEpisodesRandomPolicyValue =
  | "WITHOUT_REPLACEMENT"
  | "WITH_REPLACEMENT";
export type PodcastSavedEpisodesCadenceUnitValue = "WEEK";

export type PodcastSavedEpisodesPolicySnapshot = {
  sourcePlaylistId: string;
  enabled: boolean;
  episodeOrder: PodcastSavedEpisodesOrderValue;
  randomPolicy: PodcastSavedEpisodesRandomPolicyValue;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastSavedEpisodesCadenceUnitValue | null;
  frequencyScope: PodcastSavedEpisodesFrequencyScopeValue;
};

export type PodcastSavedEpisodesPolicyUpdate = Omit<
  PodcastSavedEpisodesPolicySnapshot,
  "sourcePlaylistId"
>;

export class PodcastSavedEpisodesPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodcastSavedEpisodesPolicyValidationError";
  }
}

/**
 * PODCAST-07 Gate 1 read-model. Absence of a row is intentional and means the
 * new SAVED_EPISODES default has never been explicitly configured.
 */
export async function loadPodcastSavedEpisodesPolicy(
  userId: string,
  sourcePlaylistId: string,
): Promise<PodcastSavedEpisodesPolicySnapshot | null> {
  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id: sourcePlaylistId,
      userId,
      kind: "PODCAST",
      spotifyType: "SAVED_EPISODES",
    },
    select: {
      podcastSavedEpisodesPolicy: {
        select: {
          sourcePlaylistId: true,
          enabled: true,
          episodeOrder: true,
          randomPolicy: true,
          cadenceMaxEpisodes: true,
          cadenceUnit: true,
          frequencyScope: true,
        },
      },
    },
  });

  const policy = source?.podcastSavedEpisodesPolicy;
  if (!policy) return null;

  return {
    sourcePlaylistId: policy.sourcePlaylistId,
    enabled: policy.enabled,
    episodeOrder: policy.episodeOrder,
    randomPolicy: policy.randomPolicy,
    cadenceMaxEpisodes: policy.cadenceMaxEpisodes,
    cadenceUnit: policy.cadenceUnit as PodcastSavedEpisodesCadenceUnitValue | null,
    frequencyScope: policy.frequencyScope,
  };
}

/**
 * Persists the explicit default policy for a SAVED_EPISODES source.
 *
 * Gate 1 is deliberately persistence-only: this writer is not called from the
 * planner/generation runtime and performs no provider access.
 */
export async function savePodcastSavedEpisodesPolicy(
  userId: string,
  sourcePlaylistId: string,
  input: PodcastSavedEpisodesPolicyUpdate,
): Promise<boolean> {
  const cadence = validateCadence(input.cadenceMaxEpisodes, input.cadenceUnit);

  return prisma.$transaction(async (tx) => {
    const source = await tx.sourcePlaylist.findFirst({
      where: {
        id: sourcePlaylistId,
        userId,
        kind: "PODCAST",
        spotifyType: "SAVED_EPISODES",
      },
      select: { id: true },
    });
    if (!source) return false;

    await tx.podcastSavedEpisodesPolicy.upsert({
      where: { sourcePlaylistId },
      create: {
        sourcePlaylistId,
        userId,
        enabled: input.enabled,
        episodeOrder: input.episodeOrder,
        randomPolicy: input.randomPolicy,
        cadenceMaxEpisodes: cadence.cadenceMaxEpisodes,
        cadenceUnit: cadence.cadenceUnit,
        frequencyScope: input.frequencyScope,
      },
      update: {
        enabled: input.enabled,
        episodeOrder: input.episodeOrder,
        randomPolicy: input.randomPolicy,
        cadenceMaxEpisodes: cadence.cadenceMaxEpisodes,
        cadenceUnit: cadence.cadenceUnit,
        frequencyScope: input.frequencyScope,
      },
    });

    return true;
  });
}

function validateCadence(
  cadenceMaxEpisodes: number | null,
  cadenceUnit: PodcastSavedEpisodesCadenceUnitValue | null,
): {
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastSavedEpisodesCadenceUnitValue | null;
} {
  if (cadenceMaxEpisodes === null && cadenceUnit === null) {
    return { cadenceMaxEpisodes: null, cadenceUnit: null };
  }

  if (cadenceMaxEpisodes === null || cadenceUnit === null) {
    throw new PodcastSavedEpisodesPolicyValidationError(
      "cadenceMaxEpisodes and cadenceUnit must be configured together",
    );
  }

  if (!Number.isInteger(cadenceMaxEpisodes) || cadenceMaxEpisodes < 1) {
    throw new PodcastSavedEpisodesPolicyValidationError(
      "cadenceMaxEpisodes must be a positive integer",
    );
  }

  if (cadenceUnit !== "WEEK") {
    throw new PodcastSavedEpisodesPolicyValidationError(
      "PODCAST-07 V1 supports WEEK cadence only",
    );
  }

  return { cadenceMaxEpisodes, cadenceUnit };
}
