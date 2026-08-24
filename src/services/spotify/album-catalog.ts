import { assertSpotifyBackoffInactive } from "./backoff";
import {
  SPOTIFY_CATALOG_CACHE_TTL,
  type SpotifyCatalogReadSession,
} from "./catalog-read-session";
import { spotifyApiErrorFromResponse } from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const ARTIST_ALBUMS_PAGE_LIMIT = 50;
const ALBUM_TRACKS_PAGE_LIMIT = 50;

export type SpotifyAlbumCatalogArtist = {
  id: string;
  name: string;
};

export type SpotifyAlbumCatalogSummary = {
  id: string;
  name: string;
  uri: string;
  spotifyUrl: string | null;
  albumType: string;
  albumGroup: string | null;
  totalTracks: number;
  releaseDate: string | null;
  artists: SpotifyAlbumCatalogArtist[];
};

export type SpotifyAlbumCatalogTrack = {
  id: string;
  name: string;
  uri: string;
  durationMs: number;
  discNumber: number;
  trackNumber: number;
  isPlayable: boolean;
  artists: SpotifyAlbumCatalogArtist[];
};

export type SpotifyAlbumCatalogMetrics = {
  totalCalls: number;
  failures: number;
  rateLimitedCount: number;
  retries: number;
  retryWaitMs: number;
};

export class SpotifyAlbumCatalogClient {
  private readonly metrics: SpotifyAlbumCatalogMetrics = {
    totalCalls: 0,
    failures: 0,
    rateLimitedCount: 0,
    retries: 0,
    retryWaitMs: 0,
  };

  private constructor(
    private readonly accessToken: string,
    private readonly readSession: SpotifyCatalogReadSession | null,
  ) {}

  static async forUser(
    userId: string,
    options: { readSession?: SpotifyCatalogReadSession } = {},
  ): Promise<SpotifyAlbumCatalogClient> {
    return new SpotifyAlbumCatalogClient(
      await getSpotifyAccessToken(userId),
      options.readSession ?? null,
    );
  }

  getMetrics(): SpotifyAlbumCatalogMetrics {
    return { ...this.metrics };
  }

  /**
   * Full-length album releases returned for one Spotify artist in the user's
   * market. Singles/compilations are deliberately excluded in ALBUM-01 v1.
   * Different Spotify album IDs remain distinct editions.
   */
  async listArtistAlbums(artistId: string): Promise<SpotifyAlbumCatalogSummary[]> {
    const byId = new Map<string, SpotifyAlbumCatalogSummary>();
    let url: string | null =
      `/artists/${encodeURIComponent(artistId)}/albums?include_groups=album&market=from_token&limit=${ARTIST_ALBUMS_PAGE_LIMIT}`;

    while (url) {
      const page: SpotifyPage<SpotifyAlbumResponse> = await this.request(
        url,
        SPOTIFY_CATALOG_CACHE_TTL.artistAlbums,
      );
      for (const raw of page.items ?? []) {
        const album = readAlbum(raw);
        if (!album) continue;
        if (album.albumType !== "album") continue;
        if (album.albumGroup && album.albumGroup !== "album") continue;
        if (!album.artists.some((artist) => artist.id === artistId)) continue;
        byId.set(album.id, album);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return [...byId.values()];
  }

  /** Tracklist for one exact Spotify album edition, preserving disc/track order. */
  async getAlbumTracks(albumId: string): Promise<SpotifyAlbumCatalogTrack[]> {
    const tracks: SpotifyAlbumCatalogTrack[] = [];
    let url: string | null =
      `/albums/${encodeURIComponent(albumId)}/tracks?market=from_token&limit=${ALBUM_TRACKS_PAGE_LIMIT}`;

    while (url) {
      const page: SpotifyPage<SpotifyAlbumTrackResponse> = await this.request(
        url,
        SPOTIFY_CATALOG_CACHE_TTL.albumTracks,
      );
      for (const raw of page.items ?? []) {
        const track = readAlbumTrack(raw);
        if (track) tracks.push(track);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return tracks.sort(
      (a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber,
    );
  }

  private async request<T>(path: string, cacheTtlMs: number): Promise<T> {
    if (this.readSession) {
      const cached = await this.readSession.readCache<T>(path, cacheTtlMs);
      if (cached !== null) return cached;
    }

    let retries = 0;
    while (true) {
      await assertSpotifyBackoffInactive();
      this.readSession?.reserveNetworkRequest();
      this.metrics.totalCalls += 1;

      const response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        const payload = (await response.json()) as T;
        await this.readSession?.writeCache(path, payload);
        return payload;
      }

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

type SpotifyPage<T> = {
  items?: T[] | null;
  next?: string | null;
};

type SpotifyArtistResponse = {
  id?: string | null;
  name?: string | null;
};

type SpotifyAlbumResponse = {
  id?: string | null;
  name?: string | null;
  uri?: string | null;
  album_type?: string | null;
  album_group?: string | null;
  total_tracks?: number | null;
  release_date?: string | null;
  external_urls?: { spotify?: string | null } | null;
  artists?: SpotifyArtistResponse[] | null;
};

type SpotifyAlbumTrackResponse = {
  id?: string | null;
  name?: string | null;
  uri?: string | null;
  duration_ms?: number | null;
  disc_number?: number | null;
  track_number?: number | null;
  is_playable?: boolean | null;
  is_local?: boolean | null;
  artists?: SpotifyArtistResponse[] | null;
};

function readAlbum(raw: SpotifyAlbumResponse): SpotifyAlbumCatalogSummary | null {
  const id = raw.id?.trim();
  const name = raw.name?.trim();
  const uri = raw.uri?.trim();
  if (!id || !name || !uri) return null;
  const artists = (raw.artists ?? [])
    .map(readArtist)
    .filter((artist): artist is SpotifyAlbumCatalogArtist => Boolean(artist));
  if (artists.length === 0) return null;

  return {
    id,
    name,
    uri,
    spotifyUrl: raw.external_urls?.spotify?.trim() || null,
    albumType: raw.album_type?.trim() || "unknown",
    albumGroup: raw.album_group?.trim() || null,
    totalTracks: Math.max(0, raw.total_tracks ?? 0),
    releaseDate: raw.release_date?.trim() || null,
    artists,
  };
}

function readAlbumTrack(raw: SpotifyAlbumTrackResponse): SpotifyAlbumCatalogTrack | null {
  if (raw.is_local) return null;
  const id = raw.id?.trim();
  const name = raw.name?.trim();
  const uri = raw.uri?.trim();
  if (!id || !name || !uri) return null;
  const artists = (raw.artists ?? [])
    .map(readArtist)
    .filter((artist): artist is SpotifyAlbumCatalogArtist => Boolean(artist));
  if (artists.length === 0) return null;

  return {
    id,
    name,
    uri,
    durationMs: Math.max(0, raw.duration_ms ?? 0),
    discNumber: Math.max(1, raw.disc_number ?? 1),
    trackNumber: Math.max(1, raw.track_number ?? 1),
    isPlayable: raw.is_playable !== false,
    artists,
  };
}

function readArtist(raw: SpotifyArtistResponse): SpotifyAlbumCatalogArtist | null {
  const id = raw.id?.trim();
  const name = raw.name?.trim();
  return id && name ? { id, name } : null;
}

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
