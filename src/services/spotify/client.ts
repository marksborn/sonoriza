import type { Candidate } from "@/services/playlist-planner";

import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";

/**
 * Thin Spotify Web API client scoped to a single user. It transparently
 * refreshes the access token and exposes just what the engine needs: read
 * source content and (re)write target playlists.
 *
 * NOTE: pagination is handled for the read endpoints. Episode availability and
 * market filtering are intentionally left simple for the MVP — see TODOs.
 */
export class SpotifyClient {
  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<SpotifyClient> {
    return new SpotifyClient(await getSpotifyAccessToken(userId));
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `Spotify API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${await res.text()}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** All non-local tracks of a playlist, mapped to music candidates. */
  async getPlaylistTracks(playlistId: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    let url: string | null =
      `/playlists/${playlistId}/items?limit=100&fields=next,items(item(uri,name,duration_ms,is_local,type,artists(name)))`;

    while (url) {
      const page: SpotifyPage<PlaylistItem> = await this.request(url);
      for (const item of page.items) {
        const track = item.item;
        if (!track || track.is_local || track.type !== "track") continue;
        candidates.push({
          uri: track.uri,
          type: "MUSIC",
          title: track.name,
          subtitle: track.artists?.map((a) => a.name).join(", "),
          durationMs: track.duration_ms,
        });
      }
      url = page.next ? stripBase(page.next) : null;
    }
    return candidates;
  }

  /** All episodes of a show, mapped to podcast candidates carrying the show id. */
  async getShowEpisodes(showId: string): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    let url: string | null = `/shows/${showId}/episodes?limit=50`;

    while (url) {
      const page: SpotifyPage<Episode> = await this.request(url);
      for (const ep of page.items) {
        if (!ep) continue;
        // TODO: filter already-played episodes and market availability.
        candidates.push({
          uri: ep.uri,
          type: "PODCAST",
          title: ep.name,
          subtitle: ep.show?.name,
          programId: showId,
          durationMs: ep.duration_ms,
        });
      }
      url = page.next ? stripBase(page.next) : null;
    }
    return candidates;
  }

  async getCurrentUserId(): Promise<string> {
    const me = await this.request<{ id: string }>("/me");
    return me.id;
  }

  /** Creates a private playlist and returns its id. */
  async createPlaylist(name: string, description?: string): Promise<string> {
    const playlist = await this.request<{ id: string }>(
      `/me/playlists`,
      {
        method: "POST",
        body: JSON.stringify({ name, description, public: false }),
      },
    );
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

interface PlaylistItem {
  item: {
    uri: string;
    name: string;
    duration_ms: number;
    is_local: boolean;
    type: string;
    artists?: { name: string }[];
  } | null;
}

interface Episode {
  uri: string;
  name: string;
  duration_ms: number;
  show?: { name: string };
}

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
