import type { DiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";
import {
  canonicalSpotifyTrackId,
  readPlayableMusicCandidate,
  type SpotifyMusicTrackLike,
} from "@/services/spotify/music-availability";
import { spotifyApiErrorFromResponse } from "@/services/spotify/errors";
import { getSpotifyAccessToken } from "@/services/spotify/token";

const API = "https://api.spotify.com/v1";
const PAGE_SIZE = 50;
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;

export type LikedTrackInventoryItemStatus = "AVAILABLE" | "UNAVAILABLE" | "INVALID";

export type LikedTrackInventoryItem = {
  addedAt: string | null;
  spotifyTrackId: string | null;
  effectiveSpotifyTrackId: string | null;
  uri: string | null;
  title: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  status: LikedTrackInventoryItemStatus;
  restrictionReason: string | null;
};

export type SpotifyLikedTrackInventory = {
  items: LikedTrackInventoryItem[];
  pagesRead: number;
  providerCalls: number;
  retries: number;
  rateLimitedCount: number;
  retryWaitMs: number;
};

export type LikedTrackInventoryReport = {
  generatedAt: Date;
  mode: "READ_ONLY";
  provider: {
    rows: number;
    availableRows: number;
    unavailableRows: number;
    invalidRows: number;
    rowsWithoutCanonicalTrackId: number;
    distinctCanonicalTracks: number;
    duplicateTechnicalRows: number;
    distinctArtists: number;
    newestAddedAt: Date | null;
    oldestAddedAt: Date | null;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
  };
  local: {
    historyCanonicalTracks: number;
    likedTracksKnownInHistory: number;
    likedTracksMissingFromHistory: number;
    likedTracksWithIsrcEvidence: number;
    likedTracksWithPrimaryArtistIdEvidence: number;
    likedTracksWithIsrcConflict: number;
    likedTracksWithPrimaryArtistIdConflict: number;
  };
  synchronization: {
    pageSize: number;
    existingAdditionStrategy: "MUSIC_03_SAVED_TRACK_WATERMARK";
    additionsCanBeIncremental: true;
    removalsRequireReconciliation: true;
    fullScanProviderCalls: number;
  };
};

/**
 * LIKED-01 Gate 1.
 *
 * Reads the user's current Spotify Saved Tracks and compares that library with
 * the canonical listening-history identities already present in Sonoriza.
 * This function performs no writes: no preference signal, affinity, source,
 * playlist, planner state or Spotify library state is changed.
 */
export async function getLikedTrackInventory(
  userId: string,
): Promise<LikedTrackInventoryReport> {
  const [accessToken, localIdentity] = await Promise.all([
    getSpotifyAccessToken(userId),
    getDiscoveryTrackIdentityEvidence(userId),
  ]);
  const provider = await readSpotifyLikedTrackInventory(accessToken);
  return buildLikedTrackInventoryReport(provider, localIdentity);
}

/** @internal Exported so the provider contract can be tested without OAuth/DB. */
export async function readSpotifyLikedTrackInventory(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyLikedTrackInventory> {
  const items: LikedTrackInventoryItem[] = [];
  let pagesRead = 0;
  let providerCalls = 0;
  let retries = 0;
  let rateLimitedCount = 0;
  let retryWaitMs = 0;
  let next: string | null = `/me/tracks?market=from_token&limit=${PAGE_SIZE}`;

  while (next) {
    let pageRetries = 0;
    let page: SpotifyPage<SavedTrackItemResponse> | null = null;

    while (!page) {
      providerCalls += 1;
      const response = await fetchImpl(`${API}${next}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) {
        page = (await response.json()) as SpotifyPage<SavedTrackItemResponse>;
        break;
      }

      const error = await spotifyApiErrorFromResponse(response, {
        method: "GET",
        operation: "spotify-api",
      });
      if (error.kind === "RATE_LIMITED") {
        rateLimitedCount += 1;
        if (pageRetries < MAX_RATE_LIMIT_RETRIES) {
          pageRetries += 1;
          retries += 1;
          const waitMs =
            Math.max(
              0,
              error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS,
            ) * 1000 + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
          retryWaitMs += waitMs;
          await sleep(waitMs);
          continue;
        }
      }
      throw error;
    }

    pagesRead += 1;
    for (const item of page.items ?? []) items.push(toInventoryItem(item));
    next = page.next ? stripBase(page.next) : null;
  }

  return {
    items,
    pagesRead,
    providerCalls,
    retries,
    rateLimitedCount,
    retryWaitMs,
  };
}

export function buildLikedTrackInventoryReport(
  provider: SpotifyLikedTrackInventory,
  localIdentity: DiscoveryTrackIdentityEvidence[],
  generatedAt = new Date(),
): LikedTrackInventoryReport {
  const providerTrackIds = provider.items.flatMap((item) =>
    item.spotifyTrackId ? [item.spotifyTrackId] : [],
  );
  const distinctTrackIds = new Set(providerTrackIds);
  const localByTrackId = new Map(localIdentity.map((row) => [row.spotifyTrackId, row]));
  const matchedLocal = [...distinctTrackIds]
    .flatMap((trackId) => {
      const evidence = localByTrackId.get(trackId);
      return evidence ? [evidence] : [];
    });

  const artists = new Set<string>();
  for (const item of provider.items) {
    if (item.primaryArtistId) {
      artists.add(`id:${item.primaryArtistId}`);
    } else if (item.primaryArtistName) {
      artists.add(`name:${normalizeArtistName(item.primaryArtistName)}`);
    }
  }

  const addedDates = provider.items
    .flatMap((item) => {
      if (!item.addedAt) return [];
      const date = new Date(item.addedAt);
      return Number.isNaN(date.getTime()) ? [] : [date];
    })
    .sort((a, b) => a.getTime() - b.getTime());

  const knownInHistory = matchedLocal.length;

  return {
    generatedAt,
    mode: "READ_ONLY",
    provider: {
      rows: provider.items.length,
      availableRows: provider.items.filter((item) => item.status === "AVAILABLE").length,
      unavailableRows: provider.items.filter((item) => item.status === "UNAVAILABLE").length,
      invalidRows: provider.items.filter((item) => item.status === "INVALID").length,
      rowsWithoutCanonicalTrackId: provider.items.filter((item) => !item.spotifyTrackId).length,
      distinctCanonicalTracks: distinctTrackIds.size,
      duplicateTechnicalRows: Math.max(0, providerTrackIds.length - distinctTrackIds.size),
      distinctArtists: artists.size,
      newestAddedAt: addedDates.at(-1) ?? null,
      oldestAddedAt: addedDates[0] ?? null,
      pagesRead: provider.pagesRead,
      providerCalls: provider.providerCalls,
      retries: provider.retries,
      rateLimitedCount: provider.rateLimitedCount,
      retryWaitMs: provider.retryWaitMs,
    },
    local: {
      historyCanonicalTracks: localIdentity.length,
      likedTracksKnownInHistory: knownInHistory,
      likedTracksMissingFromHistory: Math.max(0, distinctTrackIds.size - knownInHistory),
      likedTracksWithIsrcEvidence: matchedLocal.filter((row) => row.isrc !== null).length,
      likedTracksWithPrimaryArtistIdEvidence: matchedLocal.filter(
        (row) => row.primaryArtistId !== null,
      ).length,
      likedTracksWithIsrcConflict: matchedLocal.filter((row) => row.isrcConflict).length,
      likedTracksWithPrimaryArtistIdConflict: matchedLocal.filter(
        (row) => row.primaryArtistIdConflict,
      ).length,
    },
    synchronization: {
      pageSize: PAGE_SIZE,
      existingAdditionStrategy: "MUSIC_03_SAVED_TRACK_WATERMARK",
      additionsCanBeIncremental: true,
      removalsRequireReconciliation: true,
      fullScanProviderCalls: provider.providerCalls,
    },
  };
}

function toInventoryItem(item: SavedTrackItemResponse): LikedTrackInventoryItem {
  const raw = item.track ?? null;
  const addedAt = clean(item.added_at);
  const spotifyTrackId = canonicalSpotifyTrackId(raw);
  const playable = readPlayableMusicCandidate(raw);
  const candidate = playable.candidate;
  const primaryArtist = raw?.artists?.[0] ?? null;

  const status: LikedTrackInventoryItemStatus = playable.unavailable
    ? "UNAVAILABLE"
    : !addedAt || !raw || raw.type !== "track" || raw.is_local || !spotifyTrackId || !candidate
      ? "INVALID"
      : "AVAILABLE";

  return {
    addedAt,
    spotifyTrackId,
    effectiveSpotifyTrackId: clean(raw?.id),
    uri: clean(candidate?.uri ?? raw?.uri),
    title: clean(candidate?.title ?? raw?.name),
    primaryArtistId: clean(candidate?.primaryArtistId ?? primaryArtist?.id),
    primaryArtistName: clean(candidate?.primaryArtistName ?? primaryArtist?.name),
    albumId: clean(candidate?.albumId ?? raw?.album?.id),
    albumName: clean(candidate?.albumName ?? raw?.album?.name),
    status,
    restrictionReason: playable.restrictionReason,
  };
}

function normalizeArtistName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
}

interface SavedTrackItemResponse {
  added_at?: string | null;
  track?: SpotifySavedTrackResponse | null;
}

interface SpotifySavedTrackResponse extends SpotifyMusicTrackLike {
  id?: string | null;
  album?: { id?: string | null; name?: string | null } | null;
}
