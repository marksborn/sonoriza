import type {
  EpisodeListeningState,
  PodcastListeningStatus,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type PodcastListeningObservation = {
  spotifyEpisodeId: string;
  spotifyUri: string;
  durationMs: number;
  resumePositionMs: number | null;
  fullyPlayed: boolean | null;
  observedAt?: Date;
};

export type CanonicalPodcastListeningState = {
  spotifyEpisodeId: string;
  spotifyUri: string;
  durationMs: number;
  resumePositionMs: number;
  fullyPlayed: boolean;
  status: PodcastListeningStatus;
  lastObservedAt: Date;
};

export interface PodcastListeningStateStore {
  observe(
    userId: string,
    observations: PodcastListeningObservation[],
  ): Promise<Map<string, CanonicalPodcastListeningState>>;
}

type ExistingPodcastListeningState = Pick<
  EpisodeListeningState,
  | "spotifyEpisodeId"
  | "spotifyUri"
  | "durationMs"
  | "resumePositionMs"
  | "fullyPlayed"
  | "status"
  | "lastObservedAt"
>;

/**
 * Canonical merge policy for PODCAST-04.
 *
 * Completion is intentionally sticky: once Spotify has explicitly confirmed an
 * episode as completed, a later response with a missing/reset resume point must
 * not silently make the episode eligible again. Replay remains an explicit
 * source policy (`includePlayed`).
 *
 * Before completion, progress is monotonic. A smaller provider resume position
 * is treated as a representation/reset anomaly instead of proof that the user
 * "unheard" part of an episode.
 */
export function mergePodcastListeningState(
  existing: ExistingPodcastListeningState | null,
  observation: PodcastListeningObservation,
): CanonicalPodcastListeningState {
  const durationMs = Math.max(
    0,
    Math.trunc(observation.durationMs || existing?.durationMs || 0),
  );
  const observedAt = observation.observedAt ?? new Date();
  const observedResume =
    observation.resumePositionMs === null
      ? null
      : clamp(Math.trunc(observation.resumePositionMs), 0, durationMs);
  const mergedResume = clamp(
    Math.max(existing?.resumePositionMs ?? 0, observedResume ?? 0),
    0,
    durationMs,
  );

  if (existing?.status === "COMPLETED" || observation.fullyPlayed === true) {
    return {
      spotifyEpisodeId: observation.spotifyEpisodeId,
      spotifyUri: observation.spotifyUri || existing?.spotifyUri || "",
      durationMs,
      resumePositionMs: mergedResume,
      fullyPlayed: true,
      status: "COMPLETED",
      lastObservedAt: observedAt,
    };
  }

  const status: PodcastListeningStatus =
    mergedResume > 0 ? "IN_PROGRESS" : "NOT_STARTED";

  return {
    spotifyEpisodeId: observation.spotifyEpisodeId,
    spotifyUri: observation.spotifyUri || existing?.spotifyUri || "",
    durationMs,
    resumePositionMs: mergedResume,
    fullyPlayed: false,
    status,
    lastObservedAt: observedAt,
  };
}

export const prismaPodcastListeningStateStore: PodcastListeningStateStore = {
  async observe(userId, observations) {
    if (observations.length === 0) return new Map();

    const normalized = dedupeObservations(observations);
    const ids = normalized.map((entry) => entry.spotifyEpisodeId);
    const existing = await prisma.episodeListeningState.findMany({
      where: {
        userId,
        spotifyEpisodeId: { in: ids },
      },
    });
    const existingById = new Map(
      existing.map((entry) => [entry.spotifyEpisodeId, entry]),
    );

    const merged = normalized.map((observation) =>
      mergePodcastListeningState(
        existingById.get(observation.spotifyEpisodeId) ?? null,
        observation,
      ),
    );

    await prisma.$transaction(
      merged.map((state) =>
        prisma.episodeListeningState.upsert({
          where: {
            userId_spotifyEpisodeId: {
              userId,
              spotifyEpisodeId: state.spotifyEpisodeId,
            },
          },
          create: {
            userId,
            spotifyEpisodeId: state.spotifyEpisodeId,
            spotifyUri: state.spotifyUri,
            durationMs: state.durationMs,
            resumePositionMs: state.resumePositionMs,
            fullyPlayed: state.fullyPlayed,
            status: state.status,
            lastObservedAt: state.lastObservedAt,
          },
          update: {
            spotifyUri: state.spotifyUri,
            durationMs: state.durationMs,
            resumePositionMs: state.resumePositionMs,
            fullyPlayed: state.fullyPlayed,
            status: state.status,
            lastObservedAt: state.lastObservedAt,
          },
        }),
      ),
    );

    return new Map(merged.map((state) => [state.spotifyEpisodeId, state]));
  },
};

/** In-memory store used by unit tests so reader tests do not require a DB. */
export function createVolatilePodcastListeningStateStore(): PodcastListeningStateStore {
  const states = new Map<string, CanonicalPodcastListeningState>();

  return {
    async observe(_userId, observations) {
      const result = new Map<string, CanonicalPodcastListeningState>();
      for (const observation of dedupeObservations(observations)) {
        const merged = mergePodcastListeningState(
          states.get(observation.spotifyEpisodeId) ?? null,
          observation,
        );
        states.set(observation.spotifyEpisodeId, merged);
        result.set(observation.spotifyEpisodeId, merged);
      }
      return result;
    },
  };
}

export function spotifyEpisodeIdFromUri(uri: string): string | null {
  const match = /^spotify:episode:([^:]+)$/.exec(uri.trim());
  return match?.[1] ?? null;
}

function dedupeObservations(
  observations: PodcastListeningObservation[],
): PodcastListeningObservation[] {
  const merged = new Map<string, PodcastListeningObservation>();

  for (const observation of observations) {
    if (!observation.spotifyEpisodeId) continue;
    const previous = merged.get(observation.spotifyEpisodeId);
    if (!previous) {
      merged.set(observation.spotifyEpisodeId, observation);
      continue;
    }

    merged.set(observation.spotifyEpisodeId, {
      spotifyEpisodeId: observation.spotifyEpisodeId,
      spotifyUri: observation.spotifyUri || previous.spotifyUri,
      durationMs: Math.max(previous.durationMs, observation.durationMs),
      resumePositionMs:
        previous.resumePositionMs === null && observation.resumePositionMs === null
          ? null
          : Math.max(previous.resumePositionMs ?? 0, observation.resumePositionMs ?? 0),
      fullyPlayed:
        previous.fullyPlayed === true || observation.fullyPlayed === true
          ? true
          : previous.fullyPlayed === false || observation.fullyPlayed === false
            ? false
            : null,
      observedAt:
        (observation.observedAt?.getTime() ?? 0) >=
        (previous.observedAt?.getTime() ?? 0)
          ? observation.observedAt
          : previous.observedAt,
    });
  }

  return [...merged.values()];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
