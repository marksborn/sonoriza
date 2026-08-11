import type { Prisma, SourcePlaylist } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type {
  IncrementalCandidateSource,
  IncrementalSourceBatch,
} from "@/jobs/incremental-planning";
import type { Candidate } from "@/services/playlist-planner";

import {
  inferSpotifyOperation,
  SpotifyApiError,
  spotifyApiErrorFromResponse,
  type SpotifyRequestMetrics,
  type SpotifySourceReadMetrics,
} from "./errors";
import { readPlayableMusicCandidate } from "./music-availability";
import { asPodcastLocalProcessingError } from "./podcast-listening-state-diagnostics";
import {
  prismaPodcastListeningStateStore,
  spotifyEpisodeIdFromUri,
  type PodcastListeningObservation,
  type PodcastListeningStateStore,
} from "./podcast-listening-state";
import { sortShowCandidates } from "./podcast-show-policy";
import {
  decodeMusicSourceCache,
  decodeMusicSourceCacheUnavailableTrackCount,
  decodePartialMusicSourceCache,
  encodeMusicSourceCache,
  encodePartialMusicSourceCache,
} from "./source-cache";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;

export type IncrementalSpotifySourceConfig = Pick<
  SourcePlaylist,
  | "id"
  | "userId"
  | "kind"
  | "spotifyType"
  | "spotifyId"
  | "name"
  | "includePlayed"
  | "episodeOrder"
  | "spotifySnapshotId"
  | "cachedCandidates"
>;

export type SpotifyIncrementalCandidateSource = IncrementalCandidateSource & {
  spotifyType: string;
  spotifyId: string;
};

/**
 * Read-only Spotify source client used by the generator. It exposes one page at
 * a time so the planner can stop collection as soon as the available pool is
 * sufficient. Writes stay in SpotifyClient and are never reachable while a
 * source read is incomplete.
 */
export class SpotifyIncrementalReader {
  private quotaExceeded = false;
  private readonly requestMetrics: SpotifyRequestMetrics = {
    totalCalls: 0,
    callsByOperation: {},
    rateLimitedCount: 0,
    quotaExceededCount: 0,
    retries: 0,
    retryWaitMs: 0,
    circuitOpenSkips: 0,
    cacheHits: 0,
    cacheMisses: 0,
    memoizedReadHits: 0,
    sourceReads: {},
  };

  private constructor(
    private readonly accessToken: string,
    private readonly authoritativePodcastProgramIds: ReadonlySet<string> = new Set(),
    private readonly podcastListeningStateStore: PodcastListeningStateStore =
      prismaPodcastListeningStateStore,
  ) {}

  static async forUser(
    userId: string,
    options: { authoritativePodcastProgramIds?: ReadonlySet<string> } = {},
  ): Promise<SpotifyIncrementalReader> {
    return new SpotifyIncrementalReader(
      await getSpotifyAccessToken(userId),
      options.authoritativePodcastProgramIds ?? new Set(),
      prismaPodcastListeningStateStore,
    );
  }

  getRequestMetrics(): SpotifyRequestMetrics {
    return {
      ...this.requestMetrics,
      callsByOperation: { ...this.requestMetrics.callsByOperation },
      sourceReads: Object.fromEntries(
        Object.entries(this.requestMetrics.sourceReads).map(([key, value]) => [
          key,
          { ...value },
        ]),
      ),
    };
  }

  async createSource(
    source: IncrementalSpotifySourceConfig,
  ): Promise<SpotifyIncrementalCandidateSource> {
    if (source.kind === "MUSIC") {
      if (source.spotifyType !== "PLAYLIST") {
        throw new Error(`Unsupported music source type: ${source.spotifyType}`);
      }
      return this.createMusicPlaylistSource(source);
    }

    if (source.kind !== "PODCAST") {
      throw new Error(`Unsupported source kind: ${source.kind}`);
    }

    if (source.spotifyType === "PLAYLIST") {
      return this.createPodcastPlaylistSource(source);
    }
    if (source.spotifyType === "SHOW") {
      return this.createShowSource(source);
    }
    if (source.spotifyType === "SAVED_EPISODES") {
      return this.createSavedEpisodesSource(source);
    }

    throw new Error(`Unsupported podcast source type: ${source.spotifyType}`);
  }

  private sourceMetrics(sourceKey: string): SpotifySourceReadMetrics {
    return (this.requestMetrics.sourceReads[sourceKey] ??= {
      pagesRead: 0,
      cacheHits: 0,
      cacheMisses: 0,
      snapshotUnchanged: 0,
      snapshotChanged: 0,
      memoizedHits: 0,
      cacheWrites: 0,
      cacheWriteFailures: 0,
    });
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const operation = inferSpotifyOperation(path, method);

    if (this.quotaExceeded && method === "GET") {
      this.requestMetrics.circuitOpenSkips += 1;
      throw new SpotifyApiError({
        kind: "QUOTA_EXCEEDED",
        status: 429,
        method,
        operation,
        reason: "QUOTA_EXCEEDED",
        retryable: false,
        message: `Spotify API quota already exceeded earlier in this run; ${operation} was not requested again`,
      });
    }

    let retries = 0;
    while (true) {
      this.requestMetrics.totalCalls += 1;
      this.requestMetrics.callsByOperation[operation] =
        (this.requestMetrics.callsByOperation[operation] ?? 0) + 1;

      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const error = await spotifyApiErrorFromResponse(response, {
        method,
        operation,
      });

      if (error.kind === "QUOTA_EXCEEDED") {
        this.requestMetrics.quotaExceededCount += 1;
        this.quotaExceeded = true;
        throw error;
      }

      if (error.kind === "RATE_LIMITED") {
        this.requestMetrics.rateLimitedCount += 1;
        if (retries < MAX_RATE_LIMIT_RETRIES) {
          retries += 1;
          const waitMs =
            Math.max(
              0,
              error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS,
            ) * 1000 + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
          this.requestMetrics.retries += 1;
          this.requestMetrics.retryWaitMs += waitMs;
          await sleep(waitMs);
          continue;
        }
      }

      throw error;
    }
  }

  private async getPlaylistSnapshotId(playlistId: string): Promise<string> {
    const playlist = await this.request<{ snapshot_id: string }>(
      `/playlists/${playlistId}?fields=snapshot_id`,
    );
    if (!playlist.snapshot_id) {
      throw new Error(`Spotify playlist ${playlistId} returned no snapshot_id`);
    }
    return playlist.snapshot_id;
  }

  private createMusicPlaylistSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    const sourceKey = `PLAYLIST:${source.spotifyId}`;
    const metrics = this.sourceMetrics(sourceKey);
    let initialized = false;
    let snapshotBefore: string | null = null;
    let persistedSnapshotId: string | null = source.spotifySnapshotId;
    let nextUrl: string | null = null;
    let done = false;
    let cached: Candidate[] | null = null;
    let cacheDelivered = false;
    let partialCached: Candidate[] | null = null;
    let partialCacheDelivered = false;
    let cachedUnavailableTrackCount = 0;
    let accumulatedUnavailableTrackCount = 0;
    const accumulated: Candidate[] = [];

    const itemsPath = (offset: number): string =>
      `/playlists/${source.spotifyId}/items?market=from_token&limit=50${
        offset > 0 ? `&offset=${offset}` : ""
      }&fields=next,items(item(id,uri,name,duration_ms,is_local,type,is_playable,restrictions(reason),linked_from(id),artists(id,name),album(id,name)))`;

    const nextOffsetFrom = (next: string | null): number | null => {
      if (!next) return null;
      try {
        const value = Number(new URL(next, API).searchParams.get("offset"));
        return Number.isInteger(value) && value >= 0 ? value : null;
      } catch {
        return null;
      }
    };

    const persistCache = async (
      snapshotId: string,
      payload: Prisma.InputJsonValue,
    ): Promise<void> => {
      try {
        const result = await prisma.sourcePlaylist.updateMany({
          where: { id: source.id, spotifySnapshotId: persistedSnapshotId },
          data: {
            spotifySnapshotId: snapshotId,
            cachedCandidates: payload,
            cacheUpdatedAt: new Date(),
          },
        });
        if (result.count !== 1) {
          metrics.cacheWriteFailures += 1;
          return;
        }
        persistedSnapshotId = snapshotId;
        metrics.cacheWrites += 1;
      } catch {
        metrics.cacheWriteFailures += 1;
      }
    };

    return {
      id: source.id,
      label: source.name ?? "Playlist de músicas",
      kind: "MUSIC",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async (): Promise<IncrementalSourceBatch> => {
        if (done) return { candidates: [], done: true, fromCache: cached !== null };

        if (!initialized) {
          initialized = true;
          snapshotBefore = await this.getPlaylistSnapshotId(source.spotifyId);
          const snapshotMatches = source.spotifySnapshotId === snapshotBefore;
          cached = snapshotMatches
            ? decodeMusicSourceCache(source.cachedCandidates)
            : null;
          cachedUnavailableTrackCount = snapshotMatches
            ? decodeMusicSourceCacheUnavailableTrackCount(source.cachedCandidates) ?? 0
            : 0;
          const partial =
            snapshotMatches && cached === null
              ? decodePartialMusicSourceCache(source.cachedCandidates)
              : null;

          if (cached !== null) {
            this.requestMetrics.cacheHits += 1;
            metrics.cacheHits += 1;
            metrics.snapshotUnchanged += 1;
          } else if (partial !== null) {
            this.requestMetrics.cacheHits += 1;
            metrics.cacheHits += 1;
            metrics.snapshotUnchanged += 1;
            partialCached = partial.candidates;
            cachedUnavailableTrackCount = partial.unavailableTrackCount;
            accumulated.push(...partial.candidates);
            accumulatedUnavailableTrackCount = partial.unavailableTrackCount;

            if (partial.nextOffset === null) {
              // Every item page was already collected before an earlier run
              // lost the final validation call. The metadata read above proves
              // the same snapshot is still current, so promotion is safe.
              await persistCache(
                snapshotBefore,
                encodeMusicSourceCache(
                  accumulated,
                  accumulatedUnavailableTrackCount,
                ) as Prisma.InputJsonValue,
              );
              cached = accumulated.slice();
              partialCached = null;
            } else {
              nextUrl = itemsPath(partial.nextOffset);
            }
          } else {
            this.requestMetrics.cacheMisses += 1;
            metrics.cacheMisses += 1;
            if (source.spotifySnapshotId) {
              if (snapshotMatches) metrics.snapshotUnchanged += 1;
              else metrics.snapshotChanged += 1;
            }
            nextUrl = itemsPath(0);
          }
        }

        if (cached !== null) {
          if (cacheDelivered) return { candidates: [], done: true, fromCache: true };
          cacheDelivered = true;
          done = true;
          return {
            candidates: cached,
            done: true,
            fromCache: true,
            unavailableMusicSkippedCount: cachedUnavailableTrackCount,
          };
        }

        if (partialCached !== null && !partialCacheDelivered) {
          partialCacheDelivered = true;
          return {
            candidates: partialCached,
            done: false,
            fromCache: true,
            unavailableMusicSkippedCount: cachedUnavailableTrackCount,
          };
        }

        if (!nextUrl || !snapshotBefore) {
          done = true;
          return { candidates: [], done: true };
        }

        const page: SpotifyPage<PlaylistItem> = await this.request(nextUrl);
        metrics.pagesRead += 1;
        const candidates: Candidate[] = [];
        let unavailableMusicSkippedCount = 0;
        for (const item of page.items) {
          const result = readPlayableMusicCandidate(item.item);
          if (result.unavailable) unavailableMusicSkippedCount += 1;
          if (result.candidate) candidates.push(result.candidate);
        }
        accumulatedUnavailableTrackCount += unavailableMusicSkippedCount;
        accumulated.push(...candidates);

        const providerNext = page.next;
        const nextOffset = nextOffsetFrom(providerNext);
        nextUrl = providerNext ? stripBase(providerNext) : null;
        done = nextUrl === null;

        if (!providerNext || nextOffset !== null) {
          await persistCache(
            snapshotBefore,
            encodePartialMusicSourceCache(
              accumulated,
              accumulatedUnavailableTrackCount,
              nextOffset,
            ) as Prisma.InputJsonValue,
          );
        }

        if (done) {
          const snapshotAfter = await this.getPlaylistSnapshotId(source.spotifyId);
          if (snapshotAfter !== snapshotBefore) {
            throw new Error(
              `Spotify playlist ${source.spotifyId} changed while its items were being read; collection marked incomplete`,
            );
          }

          await persistCache(
            snapshotAfter,
            encodeMusicSourceCache(
              accumulated,
              accumulatedUnavailableTrackCount,
            ) as Prisma.InputJsonValue,
          );
        }

        return { candidates, done, unavailableMusicSkippedCount };
      },
    };
  }

  private createPodcastPlaylistSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    const sourceKey = `PLAYLIST:${source.spotifyId}`;
    const metrics = this.sourceMetrics(sourceKey);
    let nextUrl: string | null =
      `/playlists/${source.spotifyId}/items?limit=50&fields=next,items(item(id,uri,name,duration_ms,is_local,type,is_playable,show(id,name),resume_point(fully_played,resume_position_ms)))`;
    let done = false;

    return {
      id: source.id,
      label: source.name ?? "Playlist de podcasts",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async (): Promise<IncrementalSourceBatch> => {
        if (done || !nextUrl) return { candidates: [], done: true };
        const page: SpotifyPage<PlaylistItem> = await this.request(nextUrl);
        metrics.pagesRead += 1;
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        const collector = createPodcastCollector(source.includePlayed, undefined, {
          userId: source.userId,
          stateStore: this.podcastListeningStateStore,
          sourceSpotifyType: "PLAYLIST",
          sourceSpotifyId: source.spotifyId,
          suppressedProgramIds: this.authoritativePodcastProgramIds,
        });
        ingestPodcastPage(collector, page.items, "item");
        return { ...(await collector.result()), done };
      },
    };
  }

  private createShowSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    const sourceKey = `SHOW:${source.spotifyId}`;
    const metrics = this.sourceMetrics(sourceKey);
    let nextUrl: string | null = `/shows/${source.spotifyId}/episodes?limit=50`;
    let done = false;

    return {
      id: source.id,
      label: source.name ?? "Programa de podcast",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async (): Promise<IncrementalSourceBatch> => {
        if (done || !nextUrl) return { candidates: [], done: true };

        const collector = createPodcastCollector(source.includePlayed, source.spotifyId, {
          userId: source.userId,
          stateStore: this.podcastListeningStateStore,
          sourceSpotifyType: "SHOW",
          sourceSpotifyId: source.spotifyId,
        });

        if (source.episodeOrder === "SOURCE_DEFAULT") {
          const page: SpotifyPage<EpisodeResponse> = await this.request(nextUrl);
          metrics.pagesRead += 1;
          nextUrl = page.next ? stripBase(page.next) : null;
          done = nextUrl === null;
          ingestPodcastPage(collector, page.items);
          return { ...(await collector.result()), done };
        }

        // Explicit chronological order must be global, never pagination-incidental.
        while (nextUrl) {
          const page: SpotifyPage<EpisodeResponse> = await this.request(nextUrl);
          metrics.pagesRead += 1;
          nextUrl = page.next ? stripBase(page.next) : null;
          ingestPodcastPage(collector, page.items);
        }
        done = true;
        const result = await collector.result();
        return {
          ...result,
          candidates: sortShowCandidates(result.candidates, source.episodeOrder),
          done: true,
        };
      },
    };
  }

  private createSavedEpisodesSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    const sourceKey = "SAVED_EPISODES";
    const metrics = this.sourceMetrics(sourceKey);
    let nextUrl: string | null = "/me/episodes?limit=50";
    let done = false;

    return {
      id: source.id,
      label: source.name ?? "Seus episódios",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      readNext: async (): Promise<IncrementalSourceBatch> => {
        if (done || !nextUrl) return { candidates: [], done: true };
        const page: SpotifyPage<SavedEpisodeResponse> = await this.request(nextUrl);
        metrics.pagesRead += 1;
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        const collector = createPodcastCollector(source.includePlayed, undefined, {
          userId: source.userId,
          stateStore: this.podcastListeningStateStore,
          sourceSpotifyType: "SAVED_EPISODES",
          sourceSpotifyId: source.spotifyId,
          suppressedProgramIds: this.authoritativePodcastProgramIds,
        });
        ingestPodcastPage(collector, page.items, "episode");
        return { ...(await collector.result()), done };
      },
    };
  }
}

interface SpotifyPage<T> {
  items: T[];
  next: string | null;
}

interface PlaylistItem {
  item: PlaylistContentResponse | null;
}

interface PlaylistContentResponse extends EpisodeResponse {
  artists?: { name: string }[];
}

interface SavedEpisodeResponse {
  episode: EpisodeResponse | null;
}

interface EpisodeResponse {
  id?: string;
  uri: string;
  name: string;
  duration_ms: number;
  type: string;
  is_local?: boolean;
  is_playable?: boolean;
  restrictions?: { reason?: string | null } | null;
  show?: {
    id?: string;
    name?: string;
  };
  release_date?: string;
  release_date_precision?: string;
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  } | null;
}

type PodcastCollectorOptions = {
  userId: string;
  stateStore: PodcastListeningStateStore;
  sourceSpotifyType?: "PLAYLIST" | "SHOW" | "SAVED_EPISODES";
  sourceSpotifyId?: string;
  suppressedProgramIds?: ReadonlySet<string>;
};

function createPodcastCollector(
  includePlayed: boolean,
  fallbackProgramId: string | undefined,
  options: PodcastCollectorOptions,
) {
  const episodes: EpisodeResponse[] = [];

  return {
    add(episode: unknown) {
      if (!isEpisodeResponse(episode)) return;
      if (episode.is_local === true || episode.is_playable === false) return;
      episodes.push(episode);
    },
    async result(): Promise<Omit<IncrementalSourceBatch, "done">> {
      const observedAt = new Date();
      let observations: PodcastListeningObservation[];

      try {
        observations = [];
        for (const episode of episodes) {
          const spotifyEpisodeId =
            episode.id?.trim() || spotifyEpisodeIdFromUri(episode.uri);
          if (!spotifyEpisodeId) continue;
          const originalDurationMs = Math.max(0, episode.duration_ms ?? 0);
          const resumePoint = episode.resume_point ?? null;
          observations.push({
            spotifyEpisodeId,
            spotifyUri: episode.uri,
            durationMs: originalDurationMs,
            resumePositionMs: resumePoint
              ? clamp(resumePoint.resume_position_ms ?? 0, 0, originalDurationMs)
              : null,
            fullyPlayed: resumePoint ? resumePoint.fully_played === true : null,
            observedAt,
          });
        }
      } catch (error) {
        throw asPodcastLocalProcessingError("NORMALIZE_EPISODES", error);
      }

      let canonicalStates: Awaited<ReturnType<PodcastListeningStateStore["observe"]>>;
      try {
        canonicalStates = await options.stateStore.observe(
          options.userId,
          observations,
        );
      } catch (error) {
        throw asPodcastLocalProcessingError("OBSERVE_STATE", error);
      }

      try {
        const candidates: Candidate[] = [];
        let playbackPositionMissingCount = 0;
        let fullyPlayedSkippedCount = 0;
        let genericPodcastSuppressedCount = 0;
        let podcastNotStartedCount = 0;
        let podcastInProgressCount = 0;
        let podcastCompletedCount = 0;

        for (const episode of episodes) {
          const spotifyEpisodeId =
            episode.id?.trim() || spotifyEpisodeIdFromUri(episode.uri);
          if (!spotifyEpisodeId) continue;
          const state = canonicalStates.get(spotifyEpisodeId);
          if (!state) continue;

          const programId = episode.show?.id ?? fallbackProgramId;
          if (
            programId &&
            options.sourceSpotifyType !== "SHOW" &&
            options.suppressedProgramIds?.has(programId)
          ) {
            genericPodcastSuppressedCount += 1;
            continue;
          }

          const resumePoint = episode.resume_point ?? null;
          if (!resumePoint) playbackPositionMissingCount += 1;

          if (state.status === "NOT_STARTED") podcastNotStartedCount += 1;
          else if (state.status === "IN_PROGRESS") podcastInProgressCount += 1;
          else podcastCompletedCount += 1;

          if (state.status === "COMPLETED" && !includePlayed) {
            fullyPlayedSkippedCount += 1;
            continue;
          }

          const originalDurationMs = Math.max(0, episode.duration_ms ?? state.durationMs);
          const currentReplayResumePositionMs =
            state.status === "COMPLETED" &&
            includePlayed &&
            resumePoint?.fully_played === false &&
            (resumePoint.resume_position_ms ?? 0) > 0
              ? clamp(resumePoint.resume_position_ms, 0, originalDurationMs)
              : null;
          const resumePositionMs =
            currentReplayResumePositionMs ??
            clamp(state.resumePositionMs, 0, originalDurationMs);
          const durationMs =
            state.status === "COMPLETED"
              ? currentReplayResumePositionMs === null
                ? originalDurationMs
                : Math.max(0, originalDurationMs - currentReplayResumePositionMs)
              : Math.max(0, originalDurationMs - resumePositionMs);
          if (durationMs <= 0) continue;

          candidates.push({
            uri: episode.uri,
            type: "PODCAST",
            title: episode.name,
            subtitle: episode.show?.name,
            programId,
            durationMs,
            originalDurationMs,
            resumePositionMs,
            playbackPositionKnown:
              Boolean(resumePoint) ||
              state.status !== "NOT_STARTED" ||
              state.resumePositionMs > 0,
            releaseDate: episode.release_date,
            releaseDatePrecision: episode.release_date_precision,
            sourceSpotifyType: options.sourceSpotifyType,
            sourceSpotifyId: options.sourceSpotifyId,
            sourceIncludePlayed: includePlayed,
          });
        }

        return {
          candidates,
          playbackPositionMissingCount,
          fullyPlayedSkippedCount,
          genericPodcastSuppressedCount,
          podcastNotStartedCount,
          podcastInProgressCount,
          podcastCompletedCount,
        };
      } catch (error) {
        throw asPodcastLocalProcessingError("BUILD_CANDIDATES", error);
      }
    },
  };
}

function ingestPodcastPage(
  collector: { add(episode: unknown): void },
  items: unknown,
  nestedKey?: "item" | "episode",
): void {
  try {
    if (!Array.isArray(items)) {
      throw new TypeError("Podcast page items must be an array");
    }

    for (const item of items) {
      collector.add(nestedKey ? readNestedEpisode(item, nestedKey) : item);
    }
  } catch (error) {
    throw asPodcastLocalProcessingError("NORMALIZE_EPISODES", error);
  }
}

function readNestedEpisode(
  value: unknown,
  key: "item" | "episode",
): unknown {
  if (!value || typeof value !== "object") return null;
  return (value as Record<string, unknown>)[key];
}

function isEpisodeResponse(value: unknown): value is EpisodeResponse {
  if (!value || typeof value !== "object") return false;
  const episode = value as Partial<EpisodeResponse>;
  return (
    typeof episode.uri === "string" &&
    episode.uri.trim().length > 0 &&
    typeof episode.name === "string" &&
    episode.name.trim().length > 0 &&
    episode.type === "episode" &&
    typeof episode.duration_ms === "number" &&
    Number.isFinite(episode.duration_ms)
  );
}

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}