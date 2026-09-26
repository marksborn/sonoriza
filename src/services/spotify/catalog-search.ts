import { assertSpotifyBackoffInactive } from "./backoff";
import {
  SPOTIFY_CATALOG_CACHE_TTL,
  type SpotifyCatalogReadSession,
} from "./catalog-read-session";
import {
  spotifyApiErrorFromResponse,
  type SpotifyOperation,
} from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 0;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const SPOTIFY_SEARCH_MAX_LIMIT = 10;

export type SpotifyCatalogArtistSummary = {
  id: string;
  name: string;
  uri: string;
  spotifyUrl: string | null;
};

export type SpotifyCatalogTrackSummary = {
  id: string;
  name: string;
  uri: string;
  spotifyUrl: string | null;
  isrc: string | null;
  artists: SpotifyCatalogArtistSummary[];
  albumId: string | null;
  albumName: string | null;
  durationMs: number;
  linkedFromTrackId?: string | null;
  isPlayable?: boolean | null;
  restrictionReason?: string | null;
};

export type SpotifyCatalogTrackLookup = {
  requestedTrackId: string;
  track: SpotifyCatalogTrackSummary | null;
};

export type SpotifyCatalogSearchMetrics = {
  totalCalls: number;
  failures: number;
  rateLimitedCount: number;
  retries: number;
  retryWaitMs: number;
};

export class SpotifyCatalogSearchClient {
  private readonly metrics: SpotifyCatalogSearchMetrics = {
    totalCalls: 0,
    failures: 0,
    rateLimitedCount: 0,
    retries: 0,
    retryWaitMs: 0,
  };
  private accessTokenPromise: Promise<string> | null = null;

  private constructor(
    private readonly userId: string,
    private readonly readSession: SpotifyCatalogReadSession | null,
  ) {}

  static async forUser(
    userId: string,
    options: { readSession?: SpotifyCatalogReadSession } = {},
  ): Promise<SpotifyCatalogSearchClient> {
    return new SpotifyCatalogSearchClient(userId, options.readSession ?? null);
  }

  getMetrics(): SpotifyCatalogSearchMetrics {
    return { ...this.metrics };
  }

  async searchArtists(artistName: string, limit = 10): Promise<SpotifyCatalogArtistSummary[]> {
    const q = `artist:\"${searchValue(artistName)}\"`;
    const payload = await this.search({ q, type: "artist", limit });
    return (payload.artists?.items ?? [])
      .map(readArtist)
      .filter((row): row is SpotifyCatalogArtistSummary => Boolean(row));
  }

  async searchTracks(input: {
    artistName: string;
    trackName?: string | null;
    limit?: number;
  }): Promise<SpotifyCatalogTrackSummary[]> {
    const clauses = [
      input.trackName ? `track:\"${searchValue(input.trackName)}\"` : null,
      `artist:\"${searchValue(input.artistName)}\"`,
    ].filter((value): value is string => Boolean(value));
    const payload = await this.search({
      q: clauses.join(" "),
      type: "track",
      limit: input.limit ?? SPOTIFY_SEARCH_MAX_LIMIT,
    });
    return (payload.tracks?.items ?? [])
      .map(readTrack)
      .filter((row): row is SpotifyCatalogTrackSummary => Boolean(row));
  }

  /**
   * Gate 3B / MUSIC-IDENTITY catalog lookup. Spotify's February 2026 API
   * migration removed the batch GET /tracks endpoint. Resolve the bounded set
   * through sequential GET /tracks/{id} calls. When a read session is supplied,
   * each successful response is persisted so later explicit evidence refreshes
   * can reuse it without repeating provider traffic.
   */
  async lookupTracksByIds(
    trackIds: readonly string[],
  ): Promise<SpotifyCatalogTrackLookup[]> {
    const ids = [...new Set(trackIds.map((value) => value.trim()).filter(Boolean))];
    const lookups: SpotifyCatalogTrackLookup[] = [];

    for (const requestedTrackId of ids) {
      const path = `/tracks/${encodeURIComponent(requestedTrackId)}`;
      const cached = this.readSession
        ? await this.readSession.readCache<SpotifyTrackResponse>(
            path,
            SPOTIFY_CATALOG_CACHE_TTL.track,
          )
        : null;
      const row = cached ?? (await this.requestJson<SpotifyTrackResponse>(path));
      if (cached === null) {
        await this.readSession?.writeCache(path, row);
      }
      lookups.push({
        requestedTrackId,
        track: readTrack(row),
      });
    }

    return lookups;
  }

  private async getAccessToken(): Promise<string> {
    this.accessTokenPromise ??= getSpotifyAccessToken(this.userId);
    return this.accessTokenPromise;
  }

  private async search(input: {
    q: string;
    type: "artist" | "track";
    limit: number;
  }): Promise<SpotifySearchResponse> {
    const limit = spotifyCatalogSearchLimit(input.limit);
    const params = new URLSearchParams({
      q: input.q,
      type: input.type,
      limit: String(limit),
    });
    const path = `/search?${params.toString()}`;

    if (this.readSession) {
      const cached = await this.readSession.readCache<SpotifySearchResponse>(
        path,
        SPOTIFY_CATALOG_CACHE_TTL.search,
      );
      if (cached !== null) return cached;
    }

    const payload = await this.requestJson<SpotifySearchResponse>(path);
    await this.readSession?.writeCache(path, payload);
    return payload;
  }

  private async requestJson<T>(path: string): Promise<T> {
    let retries = 0;
    while (true) {
      await assertSpotifyBackoffInactive();
      this.readSession?.reserveNetworkRequest(path);
      const accessToken = await this.getAccessToken();
      this.metrics.totalCalls += 1;

      const response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      this.metrics.failures += 1;
      const error = await spotifyApiErrorFromResponse(response, {
        method: "GET",
        operation: spotifyCatalogOperationForPath(path),
      });

      if (error.kind === "RATE_LIMITED") {
        this.metrics.rateLimitedCount += 1;
        if (retries < MAX_RATE_LIMIT_RETRIES) {
          retries += 1;
          const waitMs =
            Math.max(0, error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS) * 1000;
          this.metrics.retries += 1;
          this.metrics.retryWaitMs += waitMs;
          await sleep(waitMs);
          continue;
        }
      }

      throw error;
    }
  }
}

type SpotifySearchResponse = {
  artists?: { items?: SpotifyArtistResponse[] };
  tracks?: { items?: SpotifyTrackResponse[] };
};

type SpotifyArtistResponse = {
  id?: string | null;
  name?: string | null;
  uri?: string | null;
  external_urls?: { spotify?: string | null } | null;
};

type SpotifyTrackResponse = {
  id?: string | null;
  name?: string | null;
  uri?: string | null;
  duration_ms?: number | null;
  external_urls?: { spotify?: string | null } | null;
  external_ids?: { isrc?: string | null } | null;
  artists?: SpotifyArtistResponse[] | null;
  album?: { id?: string | null; name?: string | null } | null;
  linked_from?: { id?: string | null } | null;
  is_playable?: boolean | null;
  restrictions?: { reason?: string | null } | null;
  is_local?: boolean | null;
};

function readArtist(row: SpotifyArtistResponse): SpotifyCatalogArtistSummary | null {
  if (!row.id?.trim() || !row.name?.trim() || !row.uri?.trim()) return null;
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    uri: row.uri.trim(),
    spotifyUrl: row.external_urls?.spotify?.trim() || null,
  };
}

function readTrack(row: SpotifyTrackResponse): SpotifyCatalogTrackSummary | null {
  if (row.is_local) return null;
  if (!row.id?.trim() || !row.name?.trim() || !row.uri?.trim()) return null;
  const artists = (row.artists ?? [])
    .map(readArtist)
    .filter((artist): artist is SpotifyCatalogArtistSummary => Boolean(artist));
  if (artists.length === 0) return null;
  return {
    id: row.id.trim(),
    name: row.name.trim(),
    uri: row.uri.trim(),
    spotifyUrl: row.external_urls?.spotify?.trim() || null,
    isrc: row.external_ids?.isrc?.trim() || null,
    artists,
    albumId: row.album?.id?.trim() || null,
    albumName: row.album?.name?.trim() || null,
    durationMs: Math.max(0, row.duration_ms ?? 0),
    linkedFromTrackId: row.linked_from?.id?.trim() || null,
    isPlayable:
      typeof row.is_playable === "boolean" ? row.is_playable : null,
    restrictionReason: row.restrictions?.reason?.trim() || null,
  };
}

export function spotifyCatalogSearchLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > SPOTIFY_SEARCH_MAX_LIMIT) {
    throw new Error(
      `Spotify search limit must be an integer between 1 and ${SPOTIFY_SEARCH_MAX_LIMIT}`,
    );
  }
  return value;
}

export function spotifyCatalogOperationForPath(path: string): SpotifyOperation {
  return /^\/tracks\/[^/?]+(?:\?.*)?$/.test(path) ? "catalog-track" : "spotify-api";
}

function searchValue(value: string): string {
  return value.normalize("NFKC").replace(/[\"\\]+/g, " ").replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
