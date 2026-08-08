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
import { decodeMusicSourceCache, encodeMusicSourceCache } from "./source-cache";
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

  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<SpotifyIncrementalReader> {
    return new SpotifyIncrementalReader(await getSpotifyAccessToken(userId));
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

  private async createMusicPlaylistSource(
    source: IncrementalSpotifySourceConfig,
  ): Promise<SpotifyIncrementalCandidateSource> {
    const sourceKey = `PLAYLIST:${source.spotifyId}`;
    const metrics = this.sourceMetrics(sourceKey);
    const snapshotBefore = await this.getPlaylistSnapshotId(source.spotifyId);
    const snapshotMatches = source.spotifySnapshotId === snapshotBefore;
    const cached = snapshotMatches
      ? decodeMusicSourceCache(source.cachedCandidates)
      : null;

    if (cached !== null) {
      this.requestMetrics.cacheHits += 1;
      metrics.cacheHits += 1;
      metrics.snapshotUnchanged += 1;
      let delivered = false;
      return {
        id: source.id,
        label: source.name ?? "Playlist de músicas",
        kind: "MUSIC",
        spotifyType: source.spotifyType,
        spotifyId: source.spotifyId,
        get done() {
          return delivered;
        },
        async readNext() {
          if (delivered) return { candidates: [], done: true, fromCache: true };
          delivered = true;
          return { candidates: cached, done: true, fromCache: true };
        },
      };
    }

    this.requestMetrics.cacheMisses += 1;
    metrics.cacheMisses += 1;
    if (source.spotifySnapshotId) {
      if (snapshotMatches) metrics.snapshotUnchanged += 1;
      else metrics.snapshotChanged += 1;
    }

    let nextUrl: string | null =
      `/playlists/${source.spotifyId}/items?limit=50&fields=next,items(item(uri,name,duration_ms,is_local,type,artists(name)))`;
    let done = false;
    const accumulated: Candidate[] = [];
    const reader = this;

    return {
      id: source.id,
      label: source.name ?? "Playlist de músicas",
      kind: "MUSIC",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      async readNext(): Promise<IncrementalSourceBatch> {
        if (done || !nextUrl) return { candidates: [], done: true };

        const page: SpotifyPage<PlaylistItem> = await reader.request(nextUrl);
        metrics.pagesRead += 1;
        const candidates: Candidate[] = [];
        for (const item of page.items) {
          const track = item.item;
          if (!track || track.is_local || track.type !== "track") continue;
          candidates.push({
            uri: track.uri,
            type: "MUSIC",
            title: track.name,
            subtitle: track.artists?.map((artist) => artist.name).join(", "),
            durationMs: track.duration_ms,
          });
        }
        accumulated.push(...candidates);
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        if (done) {
          const snapshotAfter = await reader.getPlaylistSnapshotId(source.spotifyId);
          if (snapshotAfter !== snapshotBefore) {
            throw new Error(
              `Spotify playlist ${source.spotifyId} changed while its items were being read; collection marked incomplete`,
            );
          }

          try {
            await prisma.sourcePlaylist.update({
              where: { id: source.id },
              data: {
                spotifySnapshotId: snapshotAfter,
                cachedCandidates: encodeMusicSourceCache(
                  accumulated,
                ) as Prisma.InputJsonValue,
                cacheUpdatedAt: new Date(),
              },
            });
            metrics.cacheWrites += 1;
          } catch {
            metrics.cacheWriteFailures += 1;
          }
        }

        return { candidates, done };
      },
    };
  }

  private createPodcastPlaylistSource(
    source: IncrementalSpotifySourceConfig,
  ): SpotifyIncrementalCandidateSource {
    const sourceKey = `PLAYLIST:${source.spotifyId}`;
    const metrics = this.sourceMetrics(sourceKey);
    let nextUrl: string | null =
      `/playlists/${source.spotifyId}/items?limit=50&fields=next,items(item(uri,name,duration_ms,is_local,type,is_playable,show(id,name),resume_point(fully_played,resume_position_ms)))`;
    let done = false;
    const reader = this;

    return {
      id: source.id,
      label: source.name ?? "Playlist de podcasts",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      async readNext(): Promise<IncrementalSourceBatch> {
        if (done || !nextUrl) return { candidates: [], done: true };
        const page: SpotifyPage<PlaylistItem> = await reader.request(nextUrl);
        metrics.pagesRead += 1;
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        const collector = createPodcastCollector(source.includePlayed);
        for (const item of page.items) {
          const episode = item.item;
          if (!episode || episode.is_local || episode.type !== "episode") continue;
          collector.add(episode);
        }
        return { ...collector.result(), done };
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
    const reader = this;

    return {
      id: source.id,
      label: source.name ?? "Programa de podcast",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      async readNext(): Promise<IncrementalSourceBatch> {
        if (done || !nextUrl) return { candidates: [], done: true };
        const page: SpotifyPage<EpisodeResponse> = await reader.request(nextUrl);
        metrics.pagesRead += 1;
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        const collector = createPodcastCollector(
          source.includePlayed,
          source.spotifyId,
        );
        for (const episode of page.items) collector.add(episode);
        return { ...collector.result(), done };
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
    const reader = this;

    return {
      id: source.id,
      label: source.name ?? "Seus episódios",
      kind: "PODCAST",
      spotifyType: source.spotifyType,
      spotifyId: source.spotifyId,
      get done() {
        return done;
      },
      async readNext(): Promise<IncrementalSourceBatch> {
        if (done || !nextUrl) return { candidates: [], done: true };
        const page: SpotifyPage<SavedEpisodeResponse> = await reader.request(nextUrl);
        metrics.pagesRead += 1;
        nextUrl = page.next ? stripBase(page.next) : null;
        done = nextUrl === null;

        const collector = createPodcastCollector(source.includePlayed);
        for (const item of page.items) {
          if (item?.episode) collector.add(item.episode);
        }
        return { ...collector.result(), done };
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
  is_local?: boolean;
  artists?: { name: string }[];
}

interface SavedEpisodeResponse {
  episode: EpisodeResponse | null;
}

interface EpisodeResponse {
  uri: string;
  name: string;
  duration_ms: number;
  type: string;
  is_playable?: boolean;
  show?: {
    id?: string;
    name?: string;
  };
  resume_point?: {
    fully_played: boolean;
    resume_position_ms: number;
  } | null;
}

function createPodcastCollector(includePlayed: boolean, fallbackProgramId?: string) {
  const candidates: Candidate[] = [];
  let playbackPositionMissingCount = 0;
  let fullyPlayedSkippedCount = 0;

  return {
    add(episode: EpisodeResponse) {
      if (!episode.uri || !episode.name || episode.type !== "episode") return;
      if (episode.is_playable === false) return;

      const resumePoint = episode.resume_point ?? null;
      if (!resumePoint) playbackPositionMissingCount += 1;

      const fullyPlayed = resumePoint?.fully_played === true;
      if (fullyPlayed && !includePlayed) {
        fullyPlayedSkippedCount += 1;
        return;
      }

      const originalDurationMs = Math.max(0, episode.duration_ms ?? 0);
      const resumePositionMs = clamp(
        resumePoint?.resume_position_ms ?? 0,
        0,
        originalDurationMs,
      );
      const durationMs = fullyPlayed
        ? originalDurationMs
        : Math.max(0, originalDurationMs - resumePositionMs);
      if (durationMs <= 0) return;

      candidates.push({
        uri: episode.uri,
        type: "PODCAST",
        title: episode.name,
        subtitle: episode.show?.name,
        programId: episode.show?.id ?? fallbackProgramId,
        durationMs,
        originalDurationMs,
        resumePositionMs,
        playbackPositionKnown: Boolean(resumePoint),
      });
    },
    result() {
      return {
        candidates,
        playbackPositionMissingCount,
        fullyPlayedSkippedCount,
      };
    },
  };
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
