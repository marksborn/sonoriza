/**
 * #473 Gate B — preview-only acquisition from existing provider clients.
 * Metadata is never treated as a saved item, a play, a like or a playlist source.
 * This service is not wired to live onboarding until later gates are reviewed.
 */
import { COLD_START_GENRES, COLD_START_PODCAST_TOPICS } from "./cold-start-contract";
import type { LastFmClient, LastFmPublicArtist, LastFmPublicTrack } from "../lastfm/client";
import type { SpotifyClient } from "../spotify/client";
import type { DiscoveredShow } from "../spotify/cold-start-show-search";

type PublicLastFm = Pick<LastFmClient,
  "getPublicTagTopArtists" | "getPublicTagTopTracks" |
  "getPublicArtistTopTracks" | "getPublicSimilarArtists">;
type ReadOnlySpotify = Pick<SpotifyClient, "searchShows" | "getDiscoveredShow">;

export interface GenrePreview {
  genreId: string;
  tag: string;
  artists: LastFmPublicArtist[];
  tracks: LastFmPublicTrack[];
  provenance: "LASTFM_PUBLIC_TAG";
  spotifyResolved: false;
}

export interface ArtistPreview {
  seedArtist: string;
  tracks: LastFmPublicTrack[];
  similarArtists: LastFmPublicArtist[];
  provenance: "LASTFM_PUBLIC_ARTIST";
  spotifyResolved: false;
}

export interface PodcastPreview {
  query: string;
  topicId: string | null;
  shows: DiscoveredShow[];
  provenance: "SPOTIFY_SEARCH";
  followed: false;
  episodesSaved: false;
}

type CacheEntry = { until: number; pending: Promise<unknown> };
const publicLastFmCache = new Map<string, CacheEntry>();
const PUBLIC_CACHE_MS = 15 * 60 * 1000;
const MAX_PUBLIC_CACHE_ENTRIES = 64;

async function withPublicCache<T>(key: string, work: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = publicLastFmCache.get(key);
  if (hit && hit.until > now) return hit.pending as Promise<T>;
  if (hit) publicLastFmCache.delete(key);
  while (publicLastFmCache.size >= MAX_PUBLIC_CACHE_ENTRIES) {
    const oldest = publicLastFmCache.keys().next().value;
    if (!oldest) break;
    publicLastFmCache.delete(oldest);
  }
  const pending = work();
  publicLastFmCache.set(key, { until: now + PUBLIC_CACHE_MS, pending });
  try {
    return await pending;
  } catch (error) {
    if (publicLastFmCache.get(key)?.pending === pending) publicLastFmCache.delete(key);
    throw error;
  }
}

/**
 * All Spotify requests go through SpotifyClient.request (quota/backoff/timeout).
 * The Last.fm cache contains only publicly discoverable tag/artist metadata.
 */
export class ColdStartPreviewService {
  constructor(
    private readonly lastfm: PublicLastFm,
    private readonly spotify: ReadOnlySpotify,
  ) {}

  async previewGenre(genreId: string): Promise<GenrePreview> {
    const genre = COLD_START_GENRES.find((entry) => entry.id === genreId);
    if (!genre) throw new Error("Unknown music genre");
    const tag = genre.lastFmTags[0];
    if (!tag) throw new Error("No public Last.fm tag mapping");
    return withPublicCache("tag:" + tag, async () => {
      const [artists, tracks] = await Promise.all([
        this.lastfm.getPublicTagTopArtists(tag, 8),
        this.lastfm.getPublicTagTopTracks(tag, 8),
      ]);
      return { genreId, tag, artists, tracks,
        provenance: "LASTFM_PUBLIC_TAG" as const,
        spotifyResolved: false as const };
    });
  }

  async previewArtist(rawName: string): Promise<ArtistPreview> {
    const seedArtist = rawName.trim().replace(/\s+/g, " ");
    if (!seedArtist || seedArtist.length > 120) throw new Error("Invalid seed artist");
    return withPublicCache("artist:" + seedArtist.toLocaleLowerCase("pt-BR"), async () => {
      const [tracks, similarArtists] = await Promise.all([
        this.lastfm.getPublicArtistTopTracks(seedArtist, 8),
        this.lastfm.getPublicSimilarArtists(seedArtist, 8),
      ]);
      return { seedArtist, tracks, similarArtists,
        provenance: "LASTFM_PUBLIC_ARTIST" as const,
        spotifyResolved: false as const };
    });
  }

  async previewPodcastTopic(topicId: string): Promise<PodcastPreview> {
    const topic = COLD_START_PODCAST_TOPICS.find((entry) => entry.id === topicId);
    if (!topic) throw new Error("Unknown podcast topic");
    const query = topic.searchTerms[0];
    if (!query) throw new Error("No podcast search mapping");
    return this.searchPodcasts(query, topicId);
  }

  async searchPodcasts(rawQuery: string, topicId: string | null = null): Promise<PodcastPreview> {
    const query = rawQuery.trim().replace(/\s+/g, " ");
    if (!query || query.length > 120) throw new Error("Invalid podcast search query");
    const shows = await this.spotify.searchShows({ query, market: "BR", limit: 8 });
    return {
      query, topicId, shows, provenance: "SPOTIFY_SEARCH",
      followed: false, episodesSaved: false,
    };
  }

  async inspectShow(id: string): Promise<DiscoveredShow | null> {
    return this.spotify.getDiscoveredShow({ id, market: "BR" });
  }
}
