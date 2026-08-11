import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/services/playlist-planner";

import {
  inferSpotifyOperation,
  SpotifyApiError,
  spotifyApiErrorFromResponse,
  type SpotifyRequestMetrics,
  type SpotifySourceReadMetrics,
} from "./errors";
import { readPlayableMusicCandidate } from "./music-availability";
import { decodeMusicSourceCache, encodeMusicSourceCache } from "./source-cache";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  ownerId?: string;
  ownerName?: string;
  collaborative: boolean;
  public: boolean | null;
}

export interface SpotifyShowSummary {
  id: string;
  name: string;
  publisher?: string;
}

export interface PodcastCandidateBatch {
  candidates: Candidate[];
  playbackPositionMissingCount: number;
  fullyPlayedSkippedCount: number;
}

/**
 * Thin Spotify Web API client scoped to a single user. It transparently
 * refreshes the access token and exposes just what the engine and configuration
 * UI need: discover source content, read podcast progress and (re)write target
 * playlists.
 */
export class SpotifyClient {
  private quotaExceeded = false;
  private readonly memoizedReads = new Map<string, Promise<unknown>>();
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
    private readonly userId: string | null = null,
  ) {}

  static async forUser(userId: string): Promise<SpotifyClient> {
    return new SpotifyClient(await getSpotifyAccessToken(userId), userId);
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

  private memoizeRead<T>(
    key: string,
    sourceKey: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const existing = this.memoizedReads.get(key);
    if (existing) {
      this.requestMetrics.memoizedReadHits += 1;
      this.sourceMetrics(sourceKey).memoizedHits += 1;
      return existing as Promise<T>;
    }

    const promise = load();
    this.memoizedReads.set(key, promise);
    return promise;
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

      const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const error = await spotifyApiErrorFromResponse(res, {
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

  /** Playlists owned or followed by the current user. */
  async listCurrentUserPlaylists(): Promise<SpotifyPlaylistSummary[]> {
    const playlists: SpotifyPlaylistSummary[] = [];
    let url: string | null = "/me/playlists?limit=50";

    while (url) {
      const page: SpotifyPage<PlaylistSummaryResponse> = await this.request(url);
      for (const playlist of page.items) {
        if (!playlist?.id || !playlist.name) continue;
        playlists.push({
          id: playlist.id,
          name: playlist.name,
          ownerId: playlist.owner?.id,
          ownerName: playlist.owner?.display_name,
          collaborative: Boolean(playlist.collaborative),
          public: playlist.public ?? null,
        });
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return playlists;
  }

  /** Shows saved in the current user's library. Requires user-library-read. */
  async listSavedShows(): Promise<SpotifyShowSummary[]> {
    const shows: SpotifyShowSummary[] = [];
    let url: string | null = "/me/shows?limit=50";

    while (url) {
      const page: SpotifyPage<SavedShowResponse> = await this.request(url);
      for (const item of page.items) {
        const show = item?.show;
        if (!show?.id || !show.name) continue;
        shows.push({
          id: show.id,
          name: show.name,
          publisher: show.publisher,
        });
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return shows;
  }

  /** Current Spotify version identifier for a playlist. */
  async getPlaylistSnapshotId(playlistId: string): Promise<string> {
    const playlist = await this.request<{ snapshot_id: string }>(
      `/playlists/${playlistId}?fields=snapshot_id`,
    );
    if (!playlist.snapshot_id) {
      throw new Error(`Spotify playlist ${playlistId} returned no snapshot_id`);
    }
    return playlist.snapshot_id;
  }

  /** All non-local tracks of a playlist, mapped to music candidates. */
  async getPlaylistTracks(playlistId: string): Promise<Candidate[]> {
    const sourceKey = `PLAYLIST:${playlistId}`;
    return this.memoizeRead(`playlist-tracks:${playlistId}`, sourceKey, () =>
      this.getPlaylistTracksCached(playlistId, sourceKey),
    );
  }

  private async getPlaylistTracksCached(
    playlistId: string,
    sourceKey: string,
  ): Promise<Candidate[]> {
    if (!this.userId) {
      return (await this.loadPlaylistTracks(playlistId, sourceKey)).candidates;
    }

    const source = await prisma.sourcePlaylist.findFirst({
      where: {
        userId: this.userId,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: playlistId,
        enabled: true,
      },
      select: {
        id: true,
        spotifySnapshotId: true,
        cachedCandidates: true,
      },
    });

    if (!source) {
      return (await this.loadPlaylistTracks(playlistId, sourceKey)).candidates;
    }

    const sourceMetrics = this.sourceMetrics(sourceKey);
    const snapshotBefore = await this.getPlaylistSnapshotId(playlistId);
    const snapshotMatches = source.spotifySnapshotId === snapshotBefore;
    const cached = snapshotMatches
      ? decodeMusicSourceCache(source.cachedCandidates)
      : null;

    if (cached !== null) {
      this.requestMetrics.cacheHits += 1;
      sourceMetrics.cacheHits += 1;
      sourceMetrics.snapshotUnchanged += 1;
      return cached;
    }

    this.requestMetrics.cacheMisses += 1;
    sourceMetrics.cacheMisses += 1;
    if (source.spotifySnapshotId) {
      if (snapshotMatches) sourceMetrics.snapshotUnchanged += 1;
      else sourceMetrics.snapshotChanged += 1;
    }

    const loaded = await this.loadPlaylistTracks(playlistId, sourceKey);
    const candidates = loaded.candidates;
    const snapshotAfter = await this.getPlaylistSnapshotId(playlistId);
    if (snapshotAfter !== snapshotBefore) {
      throw new Error(
        `Spotify playlist ${playlistId} changed while its items were being read; collection marked incomplete`,
      );
    }

    try {
      await prisma.sourcePlaylist.update({
        where: { id: source.id },
        data: {
          spotifySnapshotId: snapshotAfter,
          cachedCandidates: encodeMusicSourceCache(
            candidates,
            loaded.unavailableTrackCount,
          ) as Prisma.InputJsonValue,
          cacheUpdatedAt: new Date(),
        },
      });
      sourceMetrics.cacheWrites += 1;
    } catch {
      // Cache persistence is an optimization. Freshly collected candidates are
      // still safe for this run even if the cache itself could not be updated.
      sourceMetrics.cacheWriteFailures += 1;
    }

    return candidates;
  }

  private async loadPlaylistTracks(
    playlistId: string,
    sourceKey: string,
  ): Promise<{ candidates: Candidate[]; unavailableTrackCount: number }> {
    const candidates: Candidate[] = [];
    let unavailableTrackCount = 0;
    let url: string | null =
      `/playlists/${playlistId}/items?market=from_token&limit=50&fields=next,items(item(id,uri,name,duration_ms,is_local,type,is_playable,restrictions(reason),linked_from(id),artists(id,name),album(id,name)))`;

    while (url) {
      const page: SpotifyPage<PlaylistItem> = await this.request(url);
      this.sourceMetrics(sourceKey).pagesRead += 1;
      for (const item of page.items) {
        const result = readPlayableMusicCandidate(item.item);
        if (result.unavailable) unavailableTrackCount += 1;
        if (result.candidate) candidates.push(result.candidate);
      }
      url = page.next ? stripBase(page.next) : null;
    }
    return { candidates, unavailableTrackCount };
  }

  /** Episodes contained in a regular Spotify playlist. */
  async getPlaylistEpisodes(
    playlistId: string,
    includePlayed = false,
  ): Promise<PodcastCandidateBatch> {
    const sourceKey = `PLAYLIST:${playlistId}`;
    return this.memoizeRead(
      `playlist-episodes:${playlistId}:${includePlayed}`,
      sourceKey,
      () => this.loadPlaylistEpisodes(playlistId, includePlayed, sourceKey),
    );
  }

  private async loadPlaylistEpisodes(
    playlistId: string,
    includePlayed: boolean,
    sourceKey: string,
  ): Promise<PodcastCandidateBatch> {
    const collector = createPodcastCollector(includePlayed);
    let url: string | null =
      `/playlists/${playlistId}/items?limit=50&fields=next,items(item(uri,name,duration_ms,is_local,type,is_playable,show(id,name),resume_point(fully_played,resume_position_ms)))`;

    while (url) {
      const page: SpotifyPage<PlaylistItem> = await this.request(url);
      this.sourceMetrics(sourceKey).pagesRead += 1;
      for (const item of page.items) {
        const episode = item.item;
        if (!episode || episode.is_local || episode.type !== "episode") continue;
        collector.add(episode);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return collector.result();
  }

  /** All episodes of one show, with playback state and remaining time. */
  async getShowEpisodes(
    showId: string,
    includePlayed = false,
  ): Promise<PodcastCandidateBatch> {
    const sourceKey = `SHOW:${showId}`;
    return this.memoizeRead(`show-episodes:${showId}:${includePlayed}`, sourceKey, () =>
      this.loadShowEpisodes(showId, includePlayed, sourceKey),
    );
  }

  private async loadShowEpisodes(
    showId: string,
    includePlayed: boolean,
    sourceKey: string,
  ): Promise<PodcastCandidateBatch> {
    const collector = createPodcastCollector(includePlayed, showId);
    let url: string | null = `/shows/${showId}/episodes?limit=50`;

    while (url) {
      const page: SpotifyPage<EpisodeResponse> = await this.request(url);
      this.sourceMetrics(sourceKey).pagesRead += 1;
      for (const episode of page.items) {
        if (!episode) continue;
        collector.add(episode);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return collector.result();
  }

  /** Native Spotify "Your Episodes" library (`GET /me/episodes`). */
  async getSavedEpisodes(
    includePlayed = false,
  ): Promise<PodcastCandidateBatch> {
    const sourceKey = "SAVED_EPISODES";
    return this.memoizeRead(`saved-episodes:${includePlayed}`, sourceKey, () =>
      this.loadSavedEpisodes(includePlayed, sourceKey),
    );
  }

  private async loadSavedEpisodes(
    includePlayed: boolean,
    sourceKey: string,
  ): Promise<PodcastCandidateBatch> {
    const collector = createPodcastCollector(includePlayed);
    let url: string | null = "/me/episodes?limit=50";

    while (url) {
      const page: SpotifyPage<SavedEpisodeResponse> = await this.request(url);
      this.sourceMetrics(sourceKey).pagesRead += 1;
      for (const item of page.items) {
        if (!item?.episode) continue;
        collector.add(item.episode);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return collector.result();
  }

  async getCurrentUserId(): Promise<string> {
    const me = await this.request<{ id: string }>("/me");
    return me.id;
  }

  /** Creates a private playlist and returns its id. */
  async createPlaylist(name: string, description?: string): Promise<string> {
    const playlist = await this.request<{ id: string }>("/me/playlists", {
      method: "POST",
      body: JSON.stringify({ name, description, public: false }),
    });
    return playlist.id;
  }

  /**
   * Replaces the full contents of a playlist with `uris` (in order). Spotify
   * caps each request at 100 items, so the first call replaces and subsequent
   * calls append.
   */
  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    const chunks = chunk(uris, 100);
    // First chunk (or an empty array) replaces everything.
    await this.request(`/playlists/${playlistId}/items`, {
      method: "PUT",
      body: JSON.stringify({ uris: chunks[0] ?? [] }),
    });
    for (const extra of chunks.slice(1)) {
      await this.request(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: extra }),
      });
    }
  }
}

// --- Spotify API response shapes (only the fields we use) --------------------

interface SpotifyPage<T> {
  items: T[];
  next: string | null;
}

interface PlaylistSummaryResponse {
  id: string;
  name: string;
  collaborative?: boolean;
  public?: boolean | null;
  owner?: {
    id?: string;
    display_name?: string;
  };
}

interface SavedShowResponse {
  show: {
    id: string;
    name: string;
    publisher?: string;
  } | null;
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
  restrictions?: { reason?: string | null } | null;
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

      // A completed episode explicitly included by the user is a replay, so it
      // consumes its full duration. Partially played episodes consume only the
      // remaining listening time because Spotify resumes them from that point.
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
    result(): PodcastCandidateBatch {
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
