import { spotifyApiErrorFromResponse } from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
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

  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<SpotifyCatalogSearchClient> {
    return new SpotifyCatalogSearchClient(await getSpotifyAccessToken(userId));
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
    let retries = 0;

    while (true) {
      this.metrics.totalCalls += 1;
      const response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) return (await response.json()) as SpotifySearchResponse;

      this.metrics.failures += 1;
      const error = await spotifyApiErrorFromResponse(response, {
        method: "GET",
        operation: "spotify-api",
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

function searchValue(value: string): string {
  return value.normalize("NFKC").replace(/[\"\\]+/g, " ").replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
