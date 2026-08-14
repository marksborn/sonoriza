import type { Candidate } from "@/services/playlist-planner";

import {
  prismaPodcastListeningStateStore,
  spotifyEpisodeIdFromUri,
  type CanonicalPodcastListeningState,
  type PodcastListeningObservation,
  type PodcastListeningStateStore,
} from "./podcast-listening-state";
import { spotifyApiErrorFromResponse } from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;

type FetchLike = typeof fetch;

type EpisodePlaybackResponse = {
  id?: string;
  uri?: string;
  duration_ms?: number;
  type?: string;
  resume_point?: {
    fully_played?: boolean;
    resume_position_ms?: number;
  } | null;
};

type AuthoritativePodcastRefreshOptions = {
  accessToken?: string;
  fetchImpl?: FetchLike;
  stateStore?: PodcastListeningStateStore;
};

export type PodcastPrewriteTarget = {
  targetPlaylistId: string;
  targetName: string;
  items: readonly Candidate[];
};

export type PodcastPrewriteViolation = {
  targetPlaylistId: string;
  targetName: string;
  uri: string;
  spotifyEpisodeId: string | null;
  reason:
    | "UNVERIFIABLE_EPISODE_ID"
    | "MISSING_CANONICAL_STATE"
    | "COMPLETED_NO_REPLAY";
};

export type PodcastPrewriteGateResult = {
  checkedEpisodeIds: string[];
  violations: PodcastPrewriteViolation[];
};

/**
 * SCHEDULE-03: playlist-item resume_point proved insufficient as the sole
 * authority for KEEP_FILLED preservation. Re-read the small set of episode IDs
 * that are about to be preserved through GET /episodes/{id} and merge those
 * observations into the sticky PODCAST-04 canonical state.
 *
 * This is intentionally sequential: target playlists are small and avoiding a
 * burst is more important than shaving milliseconds off scheduled maintenance.
 */
export async function refreshAuthoritativePodcastListeningStates(
  userId: string,
  episodeIds: Iterable<string>,
  observedAt = new Date(),
  options: AuthoritativePodcastRefreshOptions = {},
) {
  const ids = [
    ...new Set(
      [...episodeIds]
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0) return new Map<string, CanonicalPodcastListeningState>();

  const accessToken =
    options.accessToken ?? (await getSpotifyAccessToken(userId));
  const fetchImpl = options.fetchImpl ?? fetch;
  const observations: PodcastListeningObservation[] = [];

  for (const episodeId of ids) {
    const episode = await getEpisodePlaybackState(
      accessToken,
      episodeId,
      fetchImpl,
    );
    observations.push(toObservation(episodeId, episode, observedAt));
  }

  return (options.stateStore ?? prismaPodcastListeningStateStore).observe(
    userId,
    observations,
  );
}

/**
 * Final fail-closed gate immediately before a real Spotify write. Every
 * selected podcast that does not explicitly allow replay is refreshed through
 * the direct episode endpoint. A newly completed item blocks the whole run
 * before any target can be modified; the next cycle can then replan safely.
 */
export async function checkPodcastCompletionBeforeWrite(
  userId: string,
  targets: Iterable<PodcastPrewriteTarget>,
  observedAt = new Date(),
  options: AuthoritativePodcastRefreshOptions = {},
): Promise<PodcastPrewriteGateResult> {
  const targetList = [...targets];
  const refreshEpisodeIds: string[] = [];
  const malformed: PodcastPrewriteViolation[] = [];

  for (const target of targetList) {
    for (const item of target.items) {
      if (item.type !== "PODCAST" || item.sourceIncludePlayed === true) continue;

      const episodeId = spotifyEpisodeIdFromUri(item.uri);
      if (!episodeId) {
        malformed.push({
          targetPlaylistId: target.targetPlaylistId,
          targetName: target.targetName,
          uri: item.uri,
          spotifyEpisodeId: null,
          reason: "UNVERIFIABLE_EPISODE_ID",
        });
        continue;
      }
      refreshEpisodeIds.push(episodeId);
    }
  }

  const checkedEpisodeIds = [...new Set(refreshEpisodeIds)];
  const states = await refreshAuthoritativePodcastListeningStates(
    userId,
    checkedEpisodeIds,
    observedAt,
    options,
  );
  const violations = [...malformed];

  for (const target of targetList) {
    for (const item of target.items) {
      if (item.type !== "PODCAST" || item.sourceIncludePlayed === true) continue;

      const episodeId = spotifyEpisodeIdFromUri(item.uri);
      if (!episodeId) continue;
      const state = states.get(episodeId);

      if (!state) {
        violations.push({
          targetPlaylistId: target.targetPlaylistId,
          targetName: target.targetName,
          uri: item.uri,
          spotifyEpisodeId: episodeId,
          reason: "MISSING_CANONICAL_STATE",
        });
        continue;
      }

      if (state.status === "COMPLETED") {
        violations.push({
          targetPlaylistId: target.targetPlaylistId,
          targetName: target.targetName,
          uri: item.uri,
          spotifyEpisodeId: episodeId,
          reason: "COMPLETED_NO_REPLAY",
        });
      }
    }
  }

  return { checkedEpisodeIds, violations };
}

async function getEpisodePlaybackState(
  accessToken: string,
  episodeId: string,
  fetchImpl: FetchLike,
): Promise<EpisodePlaybackResponse> {
  let retries = 0;

  while (true) {
    const response = await fetchImpl(
      `${API}/episodes/${encodeURIComponent(episodeId)}?market=from_token`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (response.ok) {
      return (await response.json()) as EpisodePlaybackResponse;
    }

    const error = await spotifyApiErrorFromResponse(response, {
      method: "GET",
      operation: "spotify-api",
    });

    if (error.kind === "RATE_LIMITED" && retries < MAX_RATE_LIMIT_RETRIES) {
      retries += 1;
      const waitMs =
        Math.max(
          0,
          error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS,
        ) * 1000;
      await sleep(waitMs);
      continue;
    }

    throw error;
  }
}

function toObservation(
  requestedEpisodeId: string,
  episode: EpisodePlaybackResponse,
  observedAt: Date,
): PodcastListeningObservation {
  const spotifyEpisodeId = episode.id?.trim() || requestedEpisodeId;
  const spotifyUri =
    episode.uri?.trim() || `spotify:episode:${spotifyEpisodeId}`;
  const durationMs = Math.max(0, Math.trunc(episode.duration_ms ?? 0));
  const resumePoint = episode.resume_point ?? null;
  const resumePositionMs =
    resumePoint?.resume_position_ms == null
      ? null
      : clamp(Math.trunc(resumePoint.resume_position_ms), 0, durationMs);

  return {
    spotifyEpisodeId,
    spotifyUri,
    durationMs,
    resumePositionMs,
    fullyPlayed:
      resumePoint?.fully_played == null
        ? null
        : resumePoint.fully_played === true,
    observedAt,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
