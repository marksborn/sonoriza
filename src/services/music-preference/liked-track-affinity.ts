import {
  ArtistAffinityEvidenceType,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  readSpotifyLikedTrackInventory,
  type LikedTrackInventoryItem,
  type SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";
import { getSpotifyAccessToken } from "@/services/spotify/token";

export type LikedTrackAffinitySyncMode = "PREVIEW" | "APPLY";

export type ExistingLikedTrack = {
  id: string;
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  addedAt: Date | null;
  durationMs?: number | null;
  isLiked: boolean;
  availability: LikedTrackAvailability;
};

export type ExistingArtistAffinityEvidence = {
  id: string;
  spotifyTrackId: string;
  spotifyArtistId: string;
  artistName: string | null;
  type: ArtistAffinityEvidenceType;
  active: boolean;
};

export type ExistingArtistAffinityState = {
  id: string;
  spotifyArtistId: string;
  artistName: string | null;
  likedTrackCount: number;
  active: boolean;
};

export type ExistingLikedTrackAffinityState = {
  tracks: ExistingLikedTrack[];
  evidence: ExistingArtistAffinityEvidence[];
  affinityStates: ExistingArtistAffinityState[];
};

export type PlannedLikedTrack = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  addedAt: Date | null;
  durationMs: number | null;
  availability: LikedTrackAvailability;
};

export type PlannedAffinityEvidence = {
  spotifyTrackId: string;
  spotifyArtistId: string;
  artistName: string | null;
};

export type PlannedAffinityState = {
  spotifyArtistId: string;
  artistName: string | null;
  likedTrackCount: number;
  active: boolean;
};

export type LikedTrackAffinityPlan = {
  generatedAt: Date;
  provenance: LikedTrackPreferenceProvenance;
  currentTracks: PlannedLikedTrack[];
  technicalDuplicateRows: number;
  tracksWithoutCanonicalId: number;
  tracksWithoutResolvedPrimaryArtist: number;
  tracksToCreate: PlannedLikedTrack[];
  tracksToReactivate: string[];
  tracksToUnlike: string[];
  trackMetadataUpdates: PlannedLikedTrack[];
  evidenceToCreate: PlannedAffinityEvidence[];
  evidenceToReactivate: ExistingArtistAffinityEvidence[];
  evidenceToDeactivate: ExistingArtistAffinityEvidence[];
  evidenceMetadataUpdates: PlannedAffinityEvidence[];
  affinityStatesToCreate: PlannedAffinityState[];
  affinityStatesToUpdate: PlannedAffinityState[];
  before: {
    likedTracks: number;
    activeEvidence: number;
    activeArtists: number;
  };
  after: {
    likedTracks: number;
    activeEvidence: number;
    activeArtists: number;
  };
};

export type LikedTrackAffinitySyncReport = {
  generatedAt: Date;
  mode: LikedTrackAffinitySyncMode;
  shadow: true;
  provenance: LikedTrackPreferenceProvenance;
  provider: {
    rows: number;
    distinctCanonicalTracks: number;
    technicalDuplicateRows: number;
    rowsWithoutCanonicalId: number;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
  };
  identity: {
    tracksWithResolvedPrimaryArtist: number;
    tracksWithoutResolvedPrimaryArtist: number;
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
  plannerInfluence: false;
  spotifyWrites: false;
};

/**
 * LIKED-01 Gate 2.
 *
 * Reconciles Spotify Saved Tracks into Sonoriza-owned preference state and
 * derives one explicit artist-affinity evidence row from each liked track's
 * canonical primary artist. The resulting state is shadow-only in this gate:
 * planner/discovery never reads these tables yet and Spotify is never written.
 *
 * PREVIEW is the default intended operational mode. APPLY is explicit and is
 * reserved for the later pilot/backfill gate after its before/after report has
 * been reviewed.
 */
export async function syncLikedTrackAffinity(
  userId: string,
  options: {
    mode?: LikedTrackAffinitySyncMode;
    provenance?: LikedTrackPreferenceProvenance;
  } = {},
): Promise<LikedTrackAffinitySyncReport> {
  const mode = options.mode ?? "PREVIEW";
  const provenance =
    options.provenance ?? LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL;
  const generatedAt = new Date();

  const accessToken = await getSpotifyAccessToken(userId);
  const provider = await readSpotifyLikedTrackInventory(accessToken);
  const existing = await loadExistingLikedTrackAffinityState(userId);
  const plan = buildLikedTrackAffinityPlan(provider, existing, provenance, generatedAt);

  if (mode === "APPLY") {
    await applyLikedTrackAffinityPlan(userId, plan);
  }

  return buildSyncReport(provider, plan, mode);
}

export async function loadExistingLikedTrackAffinityState(
  userId: string,
): Promise<ExistingLikedTrackAffinityState> {
  const [tracks, evidence, affinityStates] = await Promise.all([
    prisma.likedTrackPreference.findMany({
      where: { userId },
      select: {
        id: true,
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        primaryArtistId: true,
        primaryArtistName: true,
        albumId: true,
        albumName: true,
        addedAt: true,
        durationMs: true,
        isLiked: true,
        availability: true,
      },
    }),
    prisma.artistAffinityEvidence.findMany({
      where: { userId, type: ArtistAffinityEvidenceType.LIKED_TRACK },
      select: {
        id: true,
        spotifyTrackId: true,
        spotifyArtistId: true,
        artistName: true,
        type: true,
        active: true,
      },
    }),
    prisma.artistAffinityState.findMany({
      where: { userId },
      select: {
        id: true,
        spotifyArtistId: true,
        artistName: true,
        likedTrackCount: true,
        active: true,
      },
    }),
  ]);

  return { tracks, evidence, affinityStates };
}

export function buildLikedTrackAffinityPlan(
  provider: SpotifyLikedTrackInventory,
  existing: ExistingLikedTrackAffinityState,
  provenance: LikedTrackPreferenceProvenance,
  generatedAt = new Date(),
): LikedTrackAffinityPlan {
  const currentByTrackId = new Map<string, LikedTrackInventoryItem>();
  let technicalDuplicateRows = 0;
  let tracksWithoutCanonicalId = 0;

  for (const item of provider.items) {
    const trackId = item.spotifyTrackId;
    if (!trackId) {
      tracksWithoutCanonicalId += 1;
      continue;
    }
    const current = currentByTrackId.get(trackId);
    if (!current) {
      currentByTrackId.set(trackId, item);
      continue;
    }
    technicalDuplicateRows += 1;
    currentByTrackId.set(trackId, betterInventoryItem(current, item));
  }

  const currentTracks = [...currentByTrackId.values()]
    .map(toPlannedTrack)
    .sort((left, right) => left.spotifyTrackId.localeCompare(right.spotifyTrackId));
  const currentTrackIds = new Set(currentTracks.map((track) => track.spotifyTrackId));
  const existingTrackById = new Map(
    existing.tracks.map((track) => [track.spotifyTrackId, track]),
  );

  const tracksToCreate: PlannedLikedTrack[] = [];
  const tracksToReactivate: string[] = [];
  const trackMetadataUpdates: PlannedLikedTrack[] = [];

  for (const track of currentTracks) {
    const previous = existingTrackById.get(track.spotifyTrackId);
    if (!previous) {
      tracksToCreate.push(track);
      continue;
    }
    if (!previous.isLiked) tracksToReactivate.push(track.spotifyTrackId);
    if (!sameTrackMetadata(previous, track)) trackMetadataUpdates.push(track);
  }

  const tracksToUnlike = existing.tracks
    .filter((track) => track.isLiked && !currentTrackIds.has(track.spotifyTrackId))
    .map((track) => track.spotifyTrackId)
    .sort();

  const desiredEvidence = new Map<string, PlannedAffinityEvidence>();
  for (const track of currentTracks) {
    if (!track.primaryArtistId) continue;
    const evidence: PlannedAffinityEvidence = {
      spotifyTrackId: track.spotifyTrackId,
      spotifyArtistId: track.primaryArtistId,
      artistName: track.primaryArtistName,
    };
    desiredEvidence.set(evidenceKey(evidence.spotifyTrackId, evidence.spotifyArtistId), evidence);
  }

  const existingEvidenceByKey = new Map(
    existing.evidence.map((row) => [evidenceKey(row.spotifyTrackId, row.spotifyArtistId), row]),
  );
  const evidenceToCreate: PlannedAffinityEvidence[] = [];
  const evidenceToReactivate: ExistingArtistAffinityEvidence[] = [];
  const evidenceMetadataUpdates: PlannedAffinityEvidence[] = [];

  for (const [key, desired] of desiredEvidence) {
    const previous = existingEvidenceByKey.get(key);
    if (!previous) {
      evidenceToCreate.push(desired);
      continue;
    }
    if (!previous.active) evidenceToReactivate.push(previous);
    if (normalizeText(previous.artistName) !== normalizeText(desired.artistName)) {
      evidenceMetadataUpdates.push(desired);
    }
  }

  const evidenceToDeactivate = existing.evidence
    .filter(
      (row) =>
        row.type === ArtistAffinityEvidenceType.LIKED_TRACK &&
        row.active &&
        !desiredEvidence.has(evidenceKey(row.spotifyTrackId, row.spotifyArtistId)),
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  const desiredArtistCounts = new Map<string, number>();
  const desiredArtistNames = new Map<string, string | null>();
  for (const evidence of desiredEvidence.values()) {
    desiredArtistCounts.set(
      evidence.spotifyArtistId,
      (desiredArtistCounts.get(evidence.spotifyArtistId) ?? 0) + 1,
    );
    if (!desiredArtistNames.has(evidence.spotifyArtistId) || evidence.artistName) {
      desiredArtistNames.set(evidence.spotifyArtistId, evidence.artistName);
    }
  }

  const existingStateByArtist = new Map(
    existing.affinityStates.map((state) => [state.spotifyArtistId, state]),
  );
  const affinityStatesToCreate: PlannedAffinityState[] = [];
  const affinityStatesToUpdate: PlannedAffinityState[] = [];

  for (const [spotifyArtistId, likedTrackCount] of desiredArtistCounts) {
    const desired: PlannedAffinityState = {
      spotifyArtistId,
      artistName:
        desiredArtistNames.get(spotifyArtistId) ??
        existingStateByArtist.get(spotifyArtistId)?.artistName ??
        null,
      likedTrackCount,
      active: likedTrackCount > 0,
    };
    const previous = existingStateByArtist.get(spotifyArtistId);
    if (!previous) {
      affinityStatesToCreate.push(desired);
      continue;
    }
    if (
      previous.likedTrackCount !== desired.likedTrackCount ||
      previous.active !== desired.active ||
      normalizeText(previous.artistName) !== normalizeText(desired.artistName)
    ) {
      affinityStatesToUpdate.push(desired);
    }
  }

  for (const previous of existing.affinityStates) {
    if (desiredArtistCounts.has(previous.spotifyArtistId)) continue;
    if (!previous.active && previous.likedTrackCount === 0) continue;
    affinityStatesToUpdate.push({
      spotifyArtistId: previous.spotifyArtistId,
      artistName: previous.artistName,
      likedTrackCount: 0,
      active: false,
    });
  }

  affinityStatesToCreate.sort((a, b) => a.spotifyArtistId.localeCompare(b.spotifyArtistId));
  affinityStatesToUpdate.sort((a, b) => a.spotifyArtistId.localeCompare(b.spotifyArtistId));

  return {
    generatedAt,
    provenance,
    currentTracks,
    technicalDuplicateRows,
    tracksWithoutCanonicalId,
    tracksWithoutResolvedPrimaryArtist: currentTracks.filter(
      (track) => !track.primaryArtistId,
    ).length,
    tracksToCreate,
    tracksToReactivate: tracksToReactivate.sort(),
    tracksToUnlike,
    trackMetadataUpdates,
    evidenceToCreate,
    evidenceToReactivate,
    evidenceToDeactivate,
    evidenceMetadataUpdates,
    affinityStatesToCreate,
    affinityStatesToUpdate,
    before: {
      likedTracks: existing.tracks.filter((track) => track.isLiked).length,
      activeEvidence: existing.evidence.filter((row) => row.active).length,
      activeArtists: existing.affinityStates.filter((state) => state.active).length,
    },
    after: {
      likedTracks: currentTracks.length,
      activeEvidence: desiredEvidence.size,
      activeArtists: desiredArtistCounts.size,
    },
  };
}

export async function applyLikedTrackAffinityPlan(
  userId: string,
  plan: LikedTrackAffinityPlan,
): Promise<void> {
  const now = plan.generatedAt;
  const currentTrackIds = plan.currentTracks.map((track) => track.spotifyTrackId);

  await prisma.$transaction(
    async (tx) => {
      if (plan.tracksToCreate.length > 0) {
        await tx.likedTrackPreference.createMany({
          data: plan.tracksToCreate.map((track) => ({
            userId,
            ...track,
            isLiked: true,
            firstProvenance: plan.provenance,
            lastProvenance: plan.provenance,
            firstObservedAt: now,
            lastObservedAt: now,
            unlikedAt: null,
          })),
          skipDuplicates: true,
        });
      }

      for (const ids of chunks(currentTrackIds, 500)) {
        await tx.likedTrackPreference.updateMany({
          where: { userId, spotifyTrackId: { in: ids } },
          data: {
            isLiked: true,
            lastObservedAt: now,
            lastProvenance: plan.provenance,
            unlikedAt: null,
          },
        });
      }

      for (const track of plan.trackMetadataUpdates) {
        await tx.likedTrackPreference.update({
          where: {
            userId_spotifyTrackId: { userId, spotifyTrackId: track.spotifyTrackId },
          },
          data: {
            spotifyUri: track.spotifyUri,
            trackName: track.trackName,
            primaryArtistId: track.primaryArtistId,
            primaryArtistName: track.primaryArtistName,
            albumId: track.albumId,
            albumName: track.albumName,
            addedAt: track.addedAt,
            durationMs: track.durationMs,
            availability: track.availability,
          },
        });
      }

      for (const ids of chunks(plan.tracksToUnlike, 500)) {
        await tx.likedTrackPreference.updateMany({
          where: { userId, spotifyTrackId: { in: ids }, isLiked: true },
          data: {
            isLiked: false,
            unlikedAt: now,
            lastObservedAt: now,
            lastProvenance: plan.provenance,
          },
        });
      }

      if (plan.evidenceToCreate.length > 0) {
        await tx.artistAffinityEvidence.createMany({
          data: plan.evidenceToCreate.map((evidence) => ({
            userId,
            ...evidence,
            type: ArtistAffinityEvidenceType.LIKED_TRACK,
            active: true,
            firstProvenance: plan.provenance,
            lastProvenance: plan.provenance,
            firstObservedAt: now,
            lastChangedAt: now,
            removedAt: null,
          })),
          skipDuplicates: true,
        });
      }

      for (const evidence of plan.evidenceMetadataUpdates) {
        await tx.artistAffinityEvidence.update({
          where: {
            userId_type_spotifyTrackId_spotifyArtistId: {
              userId,
              type: ArtistAffinityEvidenceType.LIKED_TRACK,
              spotifyTrackId: evidence.spotifyTrackId,
              spotifyArtistId: evidence.spotifyArtistId,
            },
          },
          data: { artistName: evidence.artistName },
        });
      }

      for (const ids of chunks(plan.evidenceToReactivate.map((row) => row.id), 500)) {
        await tx.artistAffinityEvidence.updateMany({
          where: { id: { in: ids }, userId },
          data: {
            active: true,
            removedAt: null,
            lastChangedAt: now,
            lastProvenance: plan.provenance,
          },
        });
      }

      for (const ids of chunks(plan.evidenceToDeactivate.map((row) => row.id), 500)) {
        await tx.artistAffinityEvidence.updateMany({
          where: { id: { in: ids }, userId },
          data: {
            active: false,
            removedAt: now,
            lastChangedAt: now,
            lastProvenance: plan.provenance,
          },
        });
      }

      if (plan.affinityStatesToCreate.length > 0) {
        await tx.artistAffinityState.createMany({
          data: plan.affinityStatesToCreate.map((state) => ({
            userId,
            ...state,
            firstObservedAt: now,
            lastChangedAt: now,
          })),
          skipDuplicates: true,
        });
      }

      for (const state of plan.affinityStatesToUpdate) {
        await tx.artistAffinityState.upsert({
          where: {
            userId_spotifyArtistId: { userId, spotifyArtistId: state.spotifyArtistId },
          },
          create: {
            userId,
            ...state,
            firstObservedAt: now,
            lastChangedAt: now,
          },
          update: {
            artistName: state.artistName,
            likedTrackCount: state.likedTrackCount,
            active: state.active,
            lastChangedAt: now,
          },
        });
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

function buildSyncReport(
  provider: SpotifyLikedTrackInventory,
  plan: LikedTrackAffinityPlan,
  mode: LikedTrackAffinitySyncMode,
): LikedTrackAffinitySyncReport {
  return {
    generatedAt: plan.generatedAt,
    mode,
    shadow: true,
    provenance: plan.provenance,
    provider: {
      rows: provider.items.length,
      distinctCanonicalTracks: plan.currentTracks.length,
      technicalDuplicateRows: plan.technicalDuplicateRows,
      rowsWithoutCanonicalId: plan.tracksWithoutCanonicalId,
      pagesRead: provider.pagesRead,
      providerCalls: provider.providerCalls,
      retries: provider.retries,
      rateLimitedCount: provider.rateLimitedCount,
      retryWaitMs: provider.retryWaitMs,
    },
    identity: {
      tracksWithResolvedPrimaryArtist:
        plan.currentTracks.length - plan.tracksWithoutResolvedPrimaryArtist,
      tracksWithoutResolvedPrimaryArtist: plan.tracksWithoutResolvedPrimaryArtist,
    },
    before: plan.before,
    planned: {
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
    },
    after: plan.after,
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

function toPlannedTrack(item: LikedTrackInventoryItem): PlannedLikedTrack {
  if (!item.spotifyTrackId) {
    throw new Error("Canonical track id is required for persisted liked-track state");
  }
  return {
    spotifyTrackId: item.spotifyTrackId,
    spotifyUri: normalizeText(item.uri),
    trackName: normalizeText(item.title),
    primaryArtistId: normalizeText(item.primaryArtistId),
    primaryArtistName: normalizeText(item.primaryArtistName),
    albumId: normalizeText(item.albumId),
    albumName: normalizeText(item.albumName),
    addedAt: parseDate(item.addedAt),
    durationMs: normalizeDurationMs(item.durationMs),
    availability: availabilityFromInventory(item.status),
  };
}

function availabilityFromInventory(value: LikedTrackInventoryItem["status"]): LikedTrackAvailability {
  if (value === "AVAILABLE") return LikedTrackAvailability.AVAILABLE;
  if (value === "UNAVAILABLE") return LikedTrackAvailability.UNAVAILABLE;
  return LikedTrackAvailability.INVALID;
}

function betterInventoryItem(
  left: LikedTrackInventoryItem,
  right: LikedTrackInventoryItem,
): LikedTrackInventoryItem {
  const rank = (value: LikedTrackInventoryItem["status"]) =>
    value === "AVAILABLE" ? 3 : value === "UNAVAILABLE" ? 2 : 1;
  if (rank(right.status) > rank(left.status)) return right;
  if (rank(right.status) < rank(left.status)) return left;
  return right.addedAt && (!left.addedAt || right.addedAt > left.addedAt) ? right : left;
}

function sameTrackMetadata(
  previous: ExistingLikedTrack,
  current: PlannedLikedTrack,
): boolean {
  return (
    normalizeText(previous.spotifyUri) === normalizeText(current.spotifyUri) &&
    normalizeText(previous.trackName) === normalizeText(current.trackName) &&
    normalizeText(previous.primaryArtistId) === normalizeText(current.primaryArtistId) &&
    normalizeText(previous.primaryArtistName) === normalizeText(current.primaryArtistName) &&
    normalizeText(previous.albumId) === normalizeText(current.albumId) &&
    normalizeText(previous.albumName) === normalizeText(current.albumName) &&
    dateValue(previous.addedAt) === dateValue(current.addedAt) &&
    normalizeDurationMs(previous.durationMs) === current.durationMs &&
    previous.availability === current.availability
  );
}

function evidenceKey(spotifyTrackId: string, spotifyArtistId: string): string {
  return `${spotifyTrackId}\u0000${spotifyArtistId}`;
}

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function dateValue(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
