import {
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { spotifySavedTracksPlannerCapability } from "@/services/data-policy";
import {
  readSpotifyLikedTrackIncremental,
  type LikedTrackIncrementalBoundary,
} from "@/services/music-preference/liked-track-incremental-sync";
import {
  readSpotifyLikedTrackInventory,
  type LikedTrackInventoryItem,
  type SpotifyLikedTrackInventory,
} from "@/services/music-preference/liked-track-inventory";
import {
  buildLikedTrackSourceSnapshot,
  type LikedTrackSourceSnapshot,
} from "@/services/music-preference/liked-track-source";
import { getSpotifyAccessToken } from "@/services/spotify/token";

export const DEFAULT_OPERATIONAL_LIKED_TRACK_RECONCILIATION_LIMITS = {
  maxUnlikes: 25,
  maxUnlikePercent: 5,
} as const;

export type OperationalLikedTrackSyncMode = "PREVIEW" | "APPLY";
export type OperationalLikedTrackSyncStrategy = "BASELINE" | "INCREMENTAL";
export type OperationalLikedTrackReconciliationSafetyStatus =
  | "READY"
  | "BASELINE_REQUIRED"
  | "REVIEW_REQUIRED"
  | "BLOCKED";

export type OperationalLikedTrack = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  durationMs: number | null;
  addedAt: Date | null;
  availability: LikedTrackAvailability;
};

export type ExistingOperationalLikedTrack = OperationalLikedTrack & {
  id: string;
  isLiked: boolean;
  firstProvenance: LikedTrackPreferenceProvenance;
  lastProvenance: LikedTrackPreferenceProvenance;
  firstObservedAt: Date;
  lastObservedAt: Date;
  unlikedAt: Date | null;
};

export type OperationalLikedTrackPlan = {
  generatedAt: Date;
  provenance: LikedTrackPreferenceProvenance;
  currentTracks: OperationalLikedTrack[];
  technicalDuplicateRows: number;
  tracksWithoutCanonicalId: number;
  tracksToCreate: OperationalLikedTrack[];
  tracksToReactivate: string[];
  tracksToUnlike: string[];
  trackMetadataUpdates: OperationalLikedTrack[];
  beforeLikedTracks: number;
  afterLikedTracks: number;
};

export type OperationalLikedTrackSyncReport = {
  generatedAt: Date;
  mode: OperationalLikedTrackSyncMode;
  strategy: OperationalLikedTrackSyncStrategy;
  status: "READY";
  boundary: LikedTrackIncrementalBoundary | null;
  provider: {
    rowsObserved: number;
    newRows: number;
    newCanonicalRows: number;
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
    stoppedAtOlderItem: boolean;
  };
  before: { likedTracks: number };
  planned: {
    tracksToCreate: number;
    tracksToReactivate: number;
    tracksToUnlike: number;
    trackMetadataUpdates: number;
    affinityEvidenceWrites: 0;
    affinityStateWrites: 0;
  };
  after: { likedTracks: number };
  sourceProjection: Pick<
    LikedTrackSourceSnapshot,
    "counts" | "freshness" | "plannerMaterialization"
  >;
  localWritesApplied: boolean;
  spotifyWrites: false;
  plannerInfluence: false;
  nativeSourcePreferenceChanged: false;
};

export type OperationalLikedTrackReconciliationSafety = {
  status: OperationalLikedTrackReconciliationSafetyStatus;
  reasons: Array<
    | "SAFE"
    | "BASELINE_REQUIRED"
    | "CANONICAL_ID_GAPS"
    | "UNLIKE_COUNT_LIMIT"
    | "UNLIKE_PERCENT_LIMIT"
  >;
  unlikeCount: number;
  unlikePercent: number;
  rowsWithoutCanonicalId: number;
  limits: { maxUnlikes: number; maxUnlikePercent: number };
  automaticApplyAllowed: boolean;
  manualForceAllowed: boolean;
};

export type OperationalLikedTrackReconciliationReport = {
  generatedAt: Date;
  mode: OperationalLikedTrackSyncMode;
  status: OperationalLikedTrackReconciliationSafetyStatus;
  safety: OperationalLikedTrackReconciliationSafety;
  applied: boolean;
  forced: boolean;
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
  before: { likedTracks: number };
  planned: {
    tracksToCreate: number;
    tracksToReactivate: number;
    tracksToUnlike: number;
    trackMetadataUpdates: number;
    affinityEvidenceWrites: 0;
    affinityStateWrites: 0;
  };
  after: { likedTracks: number };
  sourceProjection: Pick<
    LikedTrackSourceSnapshot,
    "counts" | "freshness" | "plannerMaterialization"
  > | null;
  spotifyWrites: false;
  plannerInfluence: false;
  nativeSourcePreferenceChanged: false;
};

/**
 * Operational Saved Tracks sync for #186/#278 PERSONAL mode.
 *
 * This path is deliberately narrower than the legacy liked-track affinity
 * materializer. Saved Tracks may be persisted only as a direct operational
 * candidate pool for OPERATIONAL_PLANNING / PLANNER_ELIGIBILITY. It never
 * creates ArtistAffinityEvidence or ArtistAffinityState, never changes the
 * native-source user preference, never writes Spotify and never invokes the
 * planner.
 */
export async function syncLikedTracksOperationally(
  userId: string,
  options: { mode?: OperationalLikedTrackSyncMode } = {},
): Promise<OperationalLikedTrackSyncReport> {
  assertSpotifySavedTracksOperationalUseAllowed();

  const mode = options.mode ?? "PREVIEW";
  const generatedAt = new Date();
  const existing = await loadOperationalLikedTracks(userId);
  const active = existing.filter((track) => track.isLiked);
  const accessToken = await getSpotifyAccessToken(userId);

  if (active.length === 0) {
    const provider = await readSpotifyLikedTrackInventory(accessToken);
    const plan = buildOperationalLikedTrackPlan(
      provider,
      existing,
      LikedTrackPreferenceProvenance.LIKED_TRACK_BACKFILL,
      generatedAt,
    );

    if (mode === "APPLY") {
      await applyOperationalLikedTrackPlan(userId, plan);
    }

    return buildSyncReport({
      mode,
      strategy: "BASELINE",
      boundary: null,
      generatedAt,
      provider: {
        items: provider.items,
        newItems: provider.items,
        pagesRead: provider.pagesRead,
        providerCalls: provider.providerCalls,
        retries: provider.retries,
        rateLimitedCount: provider.rateLimitedCount,
        retryWaitMs: provider.retryWaitMs,
        stoppedAtOlderItem: false,
      },
      plan,
    });
  }

  const boundary = buildOperationalIncrementalBoundary(active);
  const provider = await readSpotifyLikedTrackIncremental(accessToken, boundary);
  const synthetic = buildOperationalSyntheticInventory(active, provider.newItems, provider);
  const plan = buildOperationalLikedTrackPlan(
    synthetic,
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    generatedAt,
  );

  if (plan.tracksToUnlike.length > 0) {
    throw new Error(
      `Operational incremental Saved Tracks sync attempted to unlike ${plan.tracksToUnlike.length} track(s); refusing partial-provider removal inference.`,
    );
  }

  if (mode === "APPLY") {
    await applyOperationalLikedTrackPlan(userId, plan);
  }

  return buildSyncReport({
    mode,
    strategy: "INCREMENTAL",
    boundary,
    generatedAt,
    provider,
    plan,
  });
}

/**
 * Full operational reconciliation for removals. The safety circuit-breaker is
 * intentionally equivalent to the legacy reconciliation thresholds, but the
 * resulting APPLY touches only LikedTrackPreference.
 */
export async function reconcileLikedTracksOperationally(
  userId: string,
  options: {
    mode?: OperationalLikedTrackSyncMode;
    force?: boolean;
    limits?: Partial<{
      maxUnlikes: number;
      maxUnlikePercent: number;
    }>;
  } = {},
): Promise<OperationalLikedTrackReconciliationReport> {
  assertSpotifySavedTracksOperationalUseAllowed();

  const mode = options.mode ?? "PREVIEW";
  const generatedAt = new Date();
  const force = options.force === true;
  const limits = normalizeReconciliationLimits(options.limits);
  const existing = await loadOperationalLikedTracks(userId);
  const activeLikedTracks = existing.filter((track) => track.isLiked).length;

  if (activeLikedTracks === 0) {
    const safety = evaluateOperationalLikedTrackReconciliationSafety({
      beforeLikedTracks: 0,
      tracksToUnlike: 0,
      rowsWithoutCanonicalId: 0,
      limits,
    });
    return {
      generatedAt,
      mode,
      status: "BASELINE_REQUIRED",
      safety,
      applied: false,
      forced: false,
      provider: {
        rows: 0,
        distinctCanonicalTracks: 0,
        technicalDuplicateRows: 0,
        rowsWithoutCanonicalId: 0,
        pagesRead: 0,
        providerCalls: 0,
        retries: 0,
        rateLimitedCount: 0,
        retryWaitMs: 0,
      },
      before: { likedTracks: 0 },
      planned: emptyPlannedCounts(),
      after: { likedTracks: 0 },
      sourceProjection: null,
      spotifyWrites: false,
      plannerInfluence: false,
      nativeSourcePreferenceChanged: false,
    };
  }

  const accessToken = await getSpotifyAccessToken(userId);
  const provider = await readSpotifyLikedTrackInventory(accessToken);
  const plan = buildOperationalLikedTrackPlan(
    provider,
    existing,
    LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
    generatedAt,
  );
  const safety = evaluateOperationalLikedTrackReconciliationSafety({
    beforeLikedTracks: plan.beforeLikedTracks,
    tracksToUnlike: plan.tracksToUnlike.length,
    rowsWithoutCanonicalId: plan.tracksWithoutCanonicalId,
    limits,
  });
  const forceCanBypass = safety.status === "REVIEW_REQUIRED" && safety.manualForceAllowed;
  const applyAllowed = safety.status === "READY" || (force && forceCanBypass);
  const applied = mode === "APPLY" && applyAllowed;

  if (applied) {
    await applyOperationalLikedTrackPlan(userId, plan);
  }

  return {
    generatedAt,
    mode,
    status: safety.status,
    safety,
    applied,
    forced: applied && force && safety.status === "REVIEW_REQUIRED",
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
    before: { likedTracks: plan.beforeLikedTracks },
    planned: plannedCounts(plan),
    after: { likedTracks: plan.afterLikedTracks },
    sourceProjection: projectOperationalSource(plan.currentTracks, generatedAt),
    spotifyWrites: false,
    plannerInfluence: false,
    nativeSourcePreferenceChanged: false,
  };
}

export async function loadOperationalLikedTracks(
  userId: string,
): Promise<ExistingOperationalLikedTrack[]> {
  return prisma.likedTrackPreference.findMany({
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
      durationMs: true,
      addedAt: true,
      isLiked: true,
      availability: true,
      firstProvenance: true,
      lastProvenance: true,
      firstObservedAt: true,
      lastObservedAt: true,
      unlikedAt: true,
    },
    orderBy: { spotifyTrackId: "asc" },
  });
}

export function buildOperationalLikedTrackPlan(
  provider: SpotifyLikedTrackInventory,
  existing: readonly ExistingOperationalLikedTrack[],
  provenance: LikedTrackPreferenceProvenance,
  generatedAt = new Date(),
): OperationalLikedTrackPlan {
  const currentByTrackId = new Map<string, LikedTrackInventoryItem>();
  let technicalDuplicateRows = 0;
  let tracksWithoutCanonicalId = 0;

  for (const item of provider.items) {
    if (!item.spotifyTrackId) {
      tracksWithoutCanonicalId += 1;
      continue;
    }
    const previous = currentByTrackId.get(item.spotifyTrackId);
    if (previous) technicalDuplicateRows += 1;
    currentByTrackId.set(
      item.spotifyTrackId,
      previous ? betterInventoryItem(previous, item) : item,
    );
  }

  const currentTracks = [...currentByTrackId.values()]
    .map(toOperationalTrack)
    .sort((left, right) => left.spotifyTrackId.localeCompare(right.spotifyTrackId));
  const currentTrackIds = new Set(currentTracks.map((track) => track.spotifyTrackId));
  const existingByTrackId = new Map(
    existing.map((track) => [track.spotifyTrackId, track]),
  );

  const tracksToCreate: OperationalLikedTrack[] = [];
  const tracksToReactivate: string[] = [];
  const trackMetadataUpdates: OperationalLikedTrack[] = [];

  for (const track of currentTracks) {
    const previous = existingByTrackId.get(track.spotifyTrackId);
    if (!previous) {
      tracksToCreate.push(track);
      continue;
    }
    if (!previous.isLiked) tracksToReactivate.push(track.spotifyTrackId);
    if (!sameTrackMetadata(previous, track)) trackMetadataUpdates.push(track);
  }

  const tracksToUnlike = existing
    .filter((track) => track.isLiked && !currentTrackIds.has(track.spotifyTrackId))
    .map((track) => track.spotifyTrackId)
    .sort();

  return {
    generatedAt,
    provenance,
    currentTracks,
    technicalDuplicateRows,
    tracksWithoutCanonicalId,
    tracksToCreate,
    tracksToReactivate: tracksToReactivate.sort(),
    tracksToUnlike,
    trackMetadataUpdates,
    beforeLikedTracks: existing.filter((track) => track.isLiked).length,
    afterLikedTracks: currentTracks.length,
  };
}

export async function applyOperationalLikedTrackPlan(
  userId: string,
  plan: OperationalLikedTrackPlan,
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
            durationMs: track.durationMs,
            addedAt: track.addedAt,
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
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

export function evaluateOperationalLikedTrackReconciliationSafety(input: {
  beforeLikedTracks: number;
  tracksToUnlike: number;
  rowsWithoutCanonicalId: number;
  limits?: Partial<{ maxUnlikes: number; maxUnlikePercent: number }>;
}): OperationalLikedTrackReconciliationSafety {
  const limits = normalizeReconciliationLimits(input.limits);
  const unlikePercent =
    input.beforeLikedTracks > 0
      ? (input.tracksToUnlike / input.beforeLikedTracks) * 100
      : 0;

  if (input.beforeLikedTracks <= 0) {
    return {
      status: "BASELINE_REQUIRED",
      reasons: ["BASELINE_REQUIRED"],
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: false,
    };
  }

  if (input.rowsWithoutCanonicalId > 0) {
    return {
      status: "BLOCKED",
      reasons: ["CANONICAL_ID_GAPS"],
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: false,
    };
  }

  const reasons: OperationalLikedTrackReconciliationSafety["reasons"] = [];
  if (input.tracksToUnlike > limits.maxUnlikes) reasons.push("UNLIKE_COUNT_LIMIT");
  if (unlikePercent > limits.maxUnlikePercent) reasons.push("UNLIKE_PERCENT_LIMIT");

  if (reasons.length > 0) {
    return {
      status: "REVIEW_REQUIRED",
      reasons,
      unlikeCount: input.tracksToUnlike,
      unlikePercent,
      rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
      limits,
      automaticApplyAllowed: false,
      manualForceAllowed: true,
    };
  }

  return {
    status: "READY",
    reasons: ["SAFE"],
    unlikeCount: input.tracksToUnlike,
    unlikePercent,
    rowsWithoutCanonicalId: input.rowsWithoutCanonicalId,
    limits,
    automaticApplyAllowed: true,
    manualForceAllowed: false,
  };
}

function assertSpotifySavedTracksOperationalUseAllowed(): void {
  const capability = spotifySavedTracksPlannerCapability();
  if (!capability.allowed) {
    throw new Error(
      "DATA_POLICY_SAVED_TRACKS_OPERATIONAL_BLOCKED: Spotify Saved Tracks are not approved for operational planner use.",
    );
  }
}

function buildOperationalIncrementalBoundary(
  active: readonly ExistingOperationalLikedTrack[],
): LikedTrackIncrementalBoundary {
  const withAddedAt = active.filter((track) => track.addedAt !== null);
  if (withAddedAt.length === 0) {
    throw new Error(
      "Operational Saved Tracks incremental sync requires at least one addedAt watermark; run a baseline rehydrate first.",
    );
  }
  const newestMs = Math.max(...withAddedAt.map((track) => track.addedAt!.getTime()));
  return {
    watermarkAddedAt: new Date(newestMs).toISOString(),
    boundaryTrackIds: active
      .filter((track) => track.addedAt?.getTime() === newestMs)
      .map((track) => track.spotifyTrackId)
      .sort(),
  };
}

function buildOperationalSyntheticInventory(
  active: readonly ExistingOperationalLikedTrack[],
  newItems: readonly LikedTrackInventoryItem[],
  provider: {
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
  },
): SpotifyLikedTrackInventory {
  const currentByTrackId = new Map<string, LikedTrackInventoryItem>();
  for (const track of active) {
    currentByTrackId.set(track.spotifyTrackId, existingTrackToInventory(track));
  }
  const invalidNewRows: LikedTrackInventoryItem[] = [];
  for (const item of newItems) {
    if (item.spotifyTrackId) currentByTrackId.set(item.spotifyTrackId, item);
    else invalidNewRows.push(item);
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

function buildSyncReport(input: {
  mode: OperationalLikedTrackSyncMode;
  strategy: OperationalLikedTrackSyncStrategy;
  boundary: LikedTrackIncrementalBoundary | null;
  generatedAt: Date;
  provider: {
    items: readonly LikedTrackInventoryItem[];
    newItems: readonly LikedTrackInventoryItem[];
    pagesRead: number;
    providerCalls: number;
    retries: number;
    rateLimitedCount: number;
    retryWaitMs: number;
    stoppedAtOlderItem: boolean;
  };
  plan: OperationalLikedTrackPlan;
}): OperationalLikedTrackSyncReport {
  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    strategy: input.strategy,
    status: "READY",
    boundary: input.boundary,
    provider: {
      rowsObserved: input.provider.items.length,
      newRows: input.provider.newItems.length,
      newCanonicalRows: input.provider.newItems.filter((item) => item.spotifyTrackId).length,
      pagesRead: input.provider.pagesRead,
      providerCalls: input.provider.providerCalls,
      retries: input.provider.retries,
      rateLimitedCount: input.provider.rateLimitedCount,
      retryWaitMs: input.provider.retryWaitMs,
      stoppedAtOlderItem: input.provider.stoppedAtOlderItem,
    },
    before: { likedTracks: input.plan.beforeLikedTracks },
    planned: plannedCounts(input.plan),
    after: { likedTracks: input.plan.afterLikedTracks },
    sourceProjection: projectOperationalSource(
      input.plan.currentTracks,
      input.generatedAt,
    ),
    localWritesApplied: input.mode === "APPLY",
    spotifyWrites: false,
    plannerInfluence: false,
    nativeSourcePreferenceChanged: false,
  };
}

function projectOperationalSource(
  tracks: readonly OperationalLikedTrack[],
  observedAt: Date,
): Pick<LikedTrackSourceSnapshot, "counts" | "freshness" | "plannerMaterialization"> {
  const snapshot = buildLikedTrackSourceSnapshot(
    tracks.map((track) => ({ ...track, lastObservedAt: observedAt })),
    observedAt,
  );
  return {
    counts: snapshot.counts,
    freshness: snapshot.freshness,
    plannerMaterialization: snapshot.plannerMaterialization,
  };
}

function plannedCounts(plan: OperationalLikedTrackPlan) {
  return {
    tracksToCreate: plan.tracksToCreate.length,
    tracksToReactivate: plan.tracksToReactivate.length,
    tracksToUnlike: plan.tracksToUnlike.length,
    trackMetadataUpdates: plan.trackMetadataUpdates.length,
    affinityEvidenceWrites: 0 as const,
    affinityStateWrites: 0 as const,
  };
}

function emptyPlannedCounts() {
  return {
    tracksToCreate: 0,
    tracksToReactivate: 0,
    tracksToUnlike: 0,
    trackMetadataUpdates: 0,
    affinityEvidenceWrites: 0 as const,
    affinityStateWrites: 0 as const,
  };
}

function normalizeReconciliationLimits(
  input:
    | Partial<{ maxUnlikes: number; maxUnlikePercent: number }>
    | undefined,
) {
  return {
    maxUnlikes: positiveInteger(
      input?.maxUnlikes,
      DEFAULT_OPERATIONAL_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikes,
    ),
    maxUnlikePercent: positiveNumber(
      input?.maxUnlikePercent,
      DEFAULT_OPERATIONAL_LIKED_TRACK_RECONCILIATION_LIMITS.maxUnlikePercent,
    ),
  };
}

function toOperationalTrack(item: LikedTrackInventoryItem): OperationalLikedTrack {
  if (!item.spotifyTrackId) {
    throw new Error("Canonical track id is required for persisted Saved Tracks state");
  }
  return {
    spotifyTrackId: item.spotifyTrackId,
    spotifyUri: clean(item.uri),
    trackName: clean(item.title),
    primaryArtistId: clean(item.primaryArtistId),
    primaryArtistName: clean(item.primaryArtistName),
    albumId: clean(item.albumId),
    albumName: clean(item.albumName),
    durationMs: validDurationMs(item.durationMs),
    addedAt: parseDate(item.addedAt),
    availability: availabilityFromInventory(item.status),
  };
}

function existingTrackToInventory(
  track: ExistingOperationalLikedTrack,
): LikedTrackInventoryItem {
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
    durationMs: track.durationMs,
    status:
      track.availability === LikedTrackAvailability.AVAILABLE
        ? "AVAILABLE"
        : track.availability === LikedTrackAvailability.UNAVAILABLE
          ? "UNAVAILABLE"
          : "INVALID",
    restrictionReason: null,
  };
}

function availabilityFromInventory(
  value: LikedTrackInventoryItem["status"],
): LikedTrackAvailability {
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
  return right.addedAt && (!left.addedAt || right.addedAt > left.addedAt)
    ? right
    : left;
}

function sameTrackMetadata(
  previous: ExistingOperationalLikedTrack,
  current: OperationalLikedTrack,
): boolean {
  return (
    clean(previous.spotifyUri) === clean(current.spotifyUri) &&
    clean(previous.trackName) === clean(current.trackName) &&
    clean(previous.primaryArtistId) === clean(current.primaryArtistId) &&
    clean(previous.primaryArtistName) === clean(current.primaryArtistName) &&
    clean(previous.albumId) === clean(current.albumId) &&
    clean(previous.albumName) === clean(current.albumName) &&
    normalizeDurationMs(previous.durationMs) === current.durationMs &&
    dateValue(previous.addedAt) === dateValue(current.addedAt) &&
    previous.availability === current.availability
  );
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validDurationMs(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function normalizeDurationMs(value: number | null | undefined): number | null {
  return validDurationMs(value);
}

function dateValue(value: Date | null): number | null {
  return value ? value.getTime() : null;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
