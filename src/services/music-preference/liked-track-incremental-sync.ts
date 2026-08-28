import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import {
  applyLikedTrackAffinityPlan,
  buildLikedTrackAffinityPlan,
  loadExistingLikedTrackAffinityState,
  type ExistingLikedTrack,
  type ExistingLikedTrackAffinityState,
  type LikedTrackAffinityPlan,
} from "@/services/music-preference/liked-track-affinity";
import type {
  LikedTrackInventoryItem,
  SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";
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

export type LikedTrackIncrementalSyncMode = "PREVIEW" | "APPLY";

export type LikedTrackIncrementalBoundary = {
  watermarkAddedAt: string;
  boundaryTrackIds: string[];
};

export type LikedTrackIncrementalProviderRead = {
  items: LikedTrackInventoryItem[];
  newItems: LikedTrackInventoryItem[];
  pagesRead: number;
  providerCalls: number;
  retries: number;
  rateLimitedCount: number;
  retryWaitMs: number;
  stoppedAtOlderItem: boolean;
};

export type LikedTrackIncrementalSyncReport = {
  generatedAt: Date;
  mode: LikedTrackIncrementalSyncMode;
  status: "READY" | "BASELINE_REQUIRED";
  boundary: LikedTrackIncrementalBoundary | null;
  provider: {
    rowsObserved: number;
    newRows: number;
    newCanonicalRows: number;
    newAvailableRows: number;
    newUnavailableRows: number;
    newInvalidRows: number;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
    stoppedAtOlderItem: boolean;
  };
  before: LikedTrackAffinityPlan["before"];
  planned: {
    tracksToCreate: number;
    tracksToReactivate: number;
    tracksToUnlike: number;
    trackMetadataUpdates: number;
    evidenceToCreate: number;
    evidenceToReactivate: number;
    evidenceToDeactivate: number;
    evidenceMetadataUpdates: number;
    affinityStatesToCreate: number;
    affinityStatesToUpdate: number;
  };
  after: LikedTrackAffinityPlan["after"];
  fullScanAvoided: true;
  removalsRequireReconciliation: true;
  plannerInfluence: false;
  spotifyWrites: false;
};

/**
 * SOURCE-LIKED-01 Gate 4B.
 *
 * Uses the canonical local liked-track state as the Saved Tracks watermark,
 * reads only the provider prefix that can contain new save events, then reuses
 * the already validated LIKED-01 affinity reconciler against a synthetic full
 * snapshot made from local active likes + the newly observed provider rows.
 *
 * The synthetic snapshot is critical: an incremental provider prefix must
 * never be interpreted as evidence that older local likes were removed.
 */
export async function syncLikedTrackIncremental(
  userId: string,
  options: { mode?: LikedTrackIncrementalSyncMode } = {},
): Promise<LikedTrackIncrementalSyncReport> {
  const mode = options.mode ?? "PREVIEW";
  const generatedAt = new Date();
  const existing = await loadExistingLikedTrackAffinityState(userId);
  const boundary = buildLikedTrackIncrementalBoundary(existing.tracks);

  if (!boundary) {
    return baselineRequiredReport(existing, mode, generatedAt);
  }

  const accessToken = await getSpotifyAccessToken(userId);
  const provider = await readSpotifyLikedTrackIncremental(
    accessToken,
    boundary,
  );
  const syntheticProvider = buildSyntheticLikedTrackInventory(existing, provider);
  const plan = buildLikedTrackAffinityPlan(
    syntheticProvider,
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    generatedAt,
  );

  if (plan.tracksToUnlike.length > 0) {
    throw new Error(
      `Incremental liked-track sync attempted to unlike ${plan.tracksToUnlike.length} track(s); refusing to apply partial-provider state.`,
    );
  }

  if (mode === "APPLY") {
    await applyLikedTrackAffinityPlan(userId, plan);
  }

  return buildReport(mode, generatedAt, boundary, provider, plan);
}

export function buildLikedTrackIncrementalBoundary(
  tracks: ExistingLikedTrack[],
): LikedTrackIncrementalBoundary | null {
  let newestMs: number | null = null;
  for (const track of tracks) {
    const value = track.addedAt?.getTime();
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (newestMs === null || value > newestMs) newestMs = value;
  }
  if (newestMs === null) return null;

  const boundaryTrackIds = [
    ...new Set(
      tracks
        .filter((track) => track.addedAt?.getTime() === newestMs)
        .map((track) => track.spotifyTrackId),
    ),
  ].sort();

  return {
    watermarkAddedAt: new Date(newestMs).toISOString(),
    boundaryTrackIds,
  };
}

/** @internal Exported for deterministic provider-contract tests. */
export async function readSpotifyLikedTrackIncremental(
  accessToken: string,
  boundary: LikedTrackIncrementalBoundary,
  fetchImpl: typeof fetch = fetch,
): Promise<LikedTrackIncrementalProviderRead> {
  const items: LikedTrackInventoryItem[] = [];
  const boundaryTrackIds = new Set(boundary.boundaryTrackIds);
  let pagesRead = 0;
  let providerCalls = 0;
  let retries = 0;
  let rateLimitedCount = 0;
  let retryWaitMs = 0;
  let stoppedAtOlderItem = false;
  let next: string | null = `/me/tracks?market=from_token&limit=${PAGE_SIZE}`;

  while (next && !stoppedAtOlderItem) {
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
    for (const raw of page.items ?? []) {
      const item = toInventoryItem(raw);
      if (item.addedAt && item.addedAt < boundary.watermarkAddedAt) {
        stoppedAtOlderItem = true;
        break;
      }
      items.push(item);
    }

    if (stoppedAtOlderItem || !page.next) break;
    next = stripBase(page.next);
  }

  const newItems = items.filter((item) => {
    if (!item.addedAt) return false;
    if (item.addedAt > boundary.watermarkAddedAt) return true;
    if (item.addedAt < boundary.watermarkAddedAt) return false;
    return !item.spotifyTrackId || !boundaryTrackIds.has(item.spotifyTrackId);
  });

  return {
    items,
    newItems,
    pagesRead,
    providerCalls,
    retries,
    rateLimitedCount,
    retryWaitMs,
    stoppedAtOlderItem,
  };
}

export function buildSyntheticLikedTrackInventory(
  existing: ExistingLikedTrackAffinityState,
  provider: LikedTrackIncrementalProviderRead,
): SpotifyLikedTrackInventory {
  const currentByTrackId = new Map<string, LikedTrackInventoryItem>();
  for (const track of existing.tracks) {
    if (!track.isLiked) continue;
    currentByTrackId.set(track.spotifyTrackId, existingTrackToInventory(track));
  }

  const invalidNewRows: LikedTrackInventoryItem[] = [];
  for (const item of provider.newItems) {
    if (item.spotifyTrackId) {
      currentByTrackId.set(item.spotifyTrackId, item);
    } else {
      invalidNewRows.push(item);
    }
  }

  return {
    items: [...currentByTrackId.values(), ...invalidNewRows],
    pagesRead: provider.pagesRead,
    providerCalls: provider.providerCalls,
    retries: provider.retries,
    rateLimitedCount: provider.rateLimitedCount,
    retryWaitMs: provider.retryWaitMs,
  };
}

function buildReport(
  mode: LikedTrackIncrementalSyncMode,
  generatedAt: Date,
  boundary: LikedTrackIncrementalBoundary,
  provider: LikedTrackIncrementalProviderRead,
  plan: LikedTrackAffinityPlan,
): LikedTrackIncrementalSyncReport {
  return {
    generatedAt,
    mode,
    status: "READY",
    boundary,
    provider: {
      rowsObserved: provider.items.length,
      newRows: provider.newItems.length,
      newCanonicalRows: provider.newItems.filter((item) => item.spotifyTrackId).length,
      newAvailableRows: provider.newItems.filter((item) => item.status === "AVAILABLE").length,
      newUnavailableRows: provider.newItems.filter((item) => item.status === "UNAVAILABLE").length,
      newInvalidRows: provider.newItems.filter((item) => item.status === "INVALID").length,
      pagesRead: provider.pagesRead,
      providerCalls: provider.providerCalls,
      retries: provider.retries,
      rateLimitedCount: provider.rateLimitedCount,
      retryWaitMs: provider.retryWaitMs,
      stoppedAtOlderItem: provider.stoppedAtOlderItem,
    },
    before: plan.before,
    planned: plannedCounts(plan),
    after: plan.after,
    fullScanAvoided: true,
    removalsRequireReconciliation: true,
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function baselineRequiredReport(
  existing: ExistingLikedTrackAffinityState,
  mode: LikedTrackIncrementalSyncMode,
  generatedAt: Date,
): LikedTrackIncrementalSyncReport {
  const activeEvidence = existing.evidence.filter((row) => row.active).length;
  const activeArtists = existing.affinityStates.filter((row) => row.active).length;
  const likedTracks = existing.tracks.filter((row) => row.isLiked).length;
  const state = { likedTracks, activeEvidence, activeArtists };
  return {
    generatedAt,
    mode,
    status: "BASELINE_REQUIRED",
    boundary: null,
    provider: {
      rowsObserved: 0,
      newRows: 0,
      newCanonicalRows: 0,
      newAvailableRows: 0,
      newUnavailableRows: 0,
      newInvalidRows: 0,
      pagesRead: 0,
      providerCalls: 0,
      retries: 0,
      rateLimitedCount: 0,
      retryWaitMs: 0,
      stoppedAtOlderItem: false,
    },
    before: state,
    planned: {
      tracksToCreate: 0,
      tracksToReactivate: 0,
      tracksToUnlike: 0,
      trackMetadataUpdates: 0,
      evidenceToCreate: 0,
      evidenceToReactivate: 0,
      evidenceToDeactivate: 0,
      evidenceMetadataUpdates: 0,
      affinityStatesToCreate: 0,
      affinityStatesToUpdate: 0,
    },
    after: state,
    fullScanAvoided: true,
    removalsRequireReconciliation: true,
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function plannedCounts(plan: LikedTrackAffinityPlan) {
  return {
    tracksToCreate: plan.tracksToCreate.length,
    tracksToReactivate: plan.tracksToReactivate.length,
    tracksToUnlike: plan.tracksToUnlike.length,
    trackMetadataUpdates: plan.trackMetadataUpdates.length,
    evidenceToCreate: plan.evidenceToCreate.length,
    evidenceToReactivate: plan.evidenceToReactivate.length,
    evidenceToDeactivate: plan.evidenceToDeactivate.length,
    evidenceMetadataUpdates: plan.evidenceMetadataUpdates.length,
    affinityStatesToCreate: plan.affinityStatesToCreate.length,
    affinityStatesToUpdate: plan.affinityStatesToUpdate.length,
  };
}

function existingTrackToInventory(track: ExistingLikedTrack): LikedTrackInventoryItem {
  return {
    addedAt: track.addedAt?.toISOString() ?? null,
    spotifyTrackId: track.spotifyTrackId,
    effectiveSpotifyTrackId: track.spotifyTrackId,
    uri: track.spotifyUri,
    title: track.trackName,
    primaryArtistId: track.primaryArtistId,
    primaryArtistName: track.primaryArtistName,
    albumId: track.albumId,
    albumName: track.albumName,
    durationMs: track.durationMs ?? null,
    status: availabilityToInventoryStatus(track.availability),
    restrictionReason: null,
  };
}

function availabilityToInventoryStatus(
  value: LikedTrackAvailability,
): LikedTrackInventoryItem["status"] {
  if (value === LikedTrackAvailability.AVAILABLE) return "AVAILABLE";
  if (value === LikedTrackAvailability.UNAVAILABLE) return "UNAVAILABLE";
  return "INVALID";
}

function toInventoryItem(item: SavedTrackItemResponse): LikedTrackInventoryItem {
  const raw = item.track ?? null;
  const addedAt = normalizeAddedAt(item.added_at);
  const spotifyTrackId = canonicalSpotifyTrackId(raw);
  const playable = readPlayableMusicCandidate(raw);
  const candidate = playable.candidate;
  const primaryArtist = raw?.artists?.[0] ?? null;

  const status: LikedTrackInventoryItem["status"] = playable.unavailable
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
    durationMs: validDurationMs(candidate?.durationMs ?? raw?.duration_ms),
    status,
    restrictionReason: playable.restrictionReason,
  };
}

function normalizeAddedAt(value: string | null | undefined): string | null {
  const normalized = clean(value);
  if (!normalized) return null;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
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
