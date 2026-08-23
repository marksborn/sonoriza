import { spotifyApiErrorFromResponse } from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;

export type SpotifyAlbumQueuePlaylist = {
  id: string;
  name: string;
  ownerId: string | null;
};

export type SpotifyAlbumQueueAlbum = {
  id: string;
  name: string;
  albumType: string;
  releaseDate: string | null;
  totalTracks: number;
  artistNames: string[];
};

export type SpotifyAlbumQueueStablePlaylist = {
  snapshotId: string;
  itemUris: Array<string | null>;
};

export type SpotifyAlbumQueuePreviewMetrics = {
  totalCalls: number;
  failures: number;
  rateLimitedCount: number;
  retries: number;
  retryWaitMs: number;
};

export class SpotifyAlbumQueuePreviewClient {
  private readonly metrics: SpotifyAlbumQueuePreviewMetrics = {
    totalCalls: 0,
    failures: 0,
    rateLimitedCount: 0,
    retries: 0,
    retryWaitMs: 0,
  };

  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<SpotifyAlbumQueuePreviewClient> {
    return new SpotifyAlbumQueuePreviewClient(await getSpotifyAccessToken(userId));
  }

  getMetrics(): SpotifyAlbumQueuePreviewMetrics {
    return { ...this.metrics };
  }

  async listCurrentUserPlaylists(): Promise<SpotifyAlbumQueuePlaylist[]> {
    const playlists: SpotifyAlbumQueuePlaylist[] = [];
    let url: string | null = "/me/playlists?limit=50";

    while (url) {
      const page: SpotifyPage<SpotifyPlaylistResponse> = await this.request(url);
      for (const raw of page.items ?? []) {
        const id = raw.id?.trim();
        const name = raw.name?.trim();
        if (!id || !name) continue;
        playlists.push({
          id,
          name,
          ownerId: raw.owner?.id?.trim() || null,
        });
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return playlists;
  }

  async getAlbum(albumId: string): Promise<SpotifyAlbumQueueAlbum> {
    const raw = await this.request<SpotifyAlbumResponse>(
      `/albums/${encodeURIComponent(albumId)}?market=from_token`,
    );
    const id = raw.id?.trim();
    const name = raw.name?.trim();
    if (!id || !name) throw new Error(`Spotify album ${albumId} returned incomplete identity`);

    return {
      id,
      name,
      albumType: raw.album_type?.trim() || "unknown",
      releaseDate: raw.release_date?.trim() || null,
      totalTracks: Math.max(0, raw.total_tracks ?? 0),
      artistNames: (raw.artists ?? [])
        .map((artist) => artist.name?.trim() || "")
        .filter((artistName) => artistName.length > 0),
    };
  }

  async readPlaylistStable(playlistId: string): Promise<SpotifyAlbumQueueStablePlaylist> {
    const snapshotBefore = await this.getPlaylistSnapshotId(playlistId);
    const itemUris = await this.getPlaylistItemUris(playlistId);
    const snapshotAfter = await this.getPlaylistSnapshotId(playlistId);
    if (snapshotBefore !== snapshotAfter) {
      throw new Error(
        `Spotify playlist ${playlistId} changed while Gate 3 was reading it; preview aborted`,
      );
    }
    return { snapshotId: snapshotAfter, itemUris };
  }

  private async getPlaylistSnapshotId(playlistId: string): Promise<string> {
    const raw = await this.request<{ snapshot_id?: string | null }>(
      `/playlists/${encodeURIComponent(playlistId)}?fields=snapshot_id`,
    );
    const snapshotId = raw.snapshot_id?.trim();
    if (!snapshotId) throw new Error(`Spotify playlist ${playlistId} returned no snapshot_id`);
    return snapshotId;
  }

  private async getPlaylistItemUris(playlistId: string): Promise<Array<string | null>> {
    const uris: Array<string | null> = [];
    let url: string | null =
      `/playlists/${encodeURIComponent(playlistId)}/items?limit=50&fields=next,items(item(uri,type,is_local))`;

    while (url) {
      const page: SpotifyPage<SpotifyPlaylistItemResponse> = await this.request(url);
      for (const row of page.items ?? []) {
        const item = row.item;
        if (!item || item.is_local) {
          uris.push(null);
          continue;
        }
        uris.push(item.uri?.trim() || null);
      }
      url = page.next ? stripBase(page.next) : null;
    }

    return uris;
  }

  private async request<T>(path: string): Promise<T> {
    let retries = 0;
    while (true) {
      this.metrics.totalCalls += 1;
      const response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) return (await response.json()) as T;

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

type SpotifyPlaylistResponse = {
  id?: string | null;
  name?: string | null;
  owner?: { id?: string | null } | null;
};

type SpotifyPlaylistItemResponse = {
  item?: {
    uri?: string | null;
    type?: string | null;
    is_local?: boolean | null;
  } | null;
};

type SpotifyAlbumResponse = {
  id?: string | null;
  name?: string | null;
  album_type?: string | null;
  release_date?: string | null;
  total_tracks?: number | null;
  artists?: Array<{ name?: string | null }> | null;
};

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
