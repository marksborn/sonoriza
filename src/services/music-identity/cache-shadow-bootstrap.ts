import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { DataLineage } from "@/services/data-policy/provenance";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  decodeMusicSourceCache,
  decodePartialMusicSourceCache,
} from "@/services/spotify/source-cache";

import {
  buildShadowBackfillCandidates,
  type ShadowBackfillObservation,
} from "./shadow-backfill";

const SPOTIFY_PROVIDER = "spotify";
const MATCH_REASON = "SINGLETON_BOOTSTRAP";
const CONFIDENCE_BASIS_POINTS = 10_000;
const SAMPLE_LIMIT = 25;

export type CacheShadowBootstrapSourceRow = {
  id: string;
  name: string | null;
  kind: "MUSIC" | "PODCAST";
  enabled: boolean;
  cachedCandidates: unknown;
  spotifySnapshotId: string | null;
  cacheUpdatedAt: Date | null;
};

export type CacheShadowBootstrapTargetRow = {
  id: string;
  name: string;
  sourceScopeMode: "INHERIT_GLOBAL" | "SELECTED_ONLY";
  sourceSelections: Array<{ sourcePlaylistId: string }>;
};

export type CacheShadowBootstrapObservation = {
  sourcePlaylistId: string;
  observedAt: Date | null;
  spotifyTrackId: string;
  spotifyUri: string;
  trackName: string;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
};

export type CacheShadowBootstrapCandidate = {
  spotifyTrackId: string;
  spotifyUri: string;
  trackName: string;
  primaryArtistId: string;
  primaryArtistName: string;
  albumId: string | null;
  albumName: string | null;
  observedAt: Date;
  sourcePlaylistIds: string[];
};

export type CacheShadowBootstrapPlan = {
  reachableSourceIds: string[];
  fullValidSources: number;
  partialValidSources: number;
  missingSources: number;
  invalidSources: number;
  missingCacheTimestampSources: number;
  distinctSpotifyTracks: number;
  alreadyCanonicalOperationalTracks: number;
  excludedBackfillEligibleTracks: number;
  candidateTracks: number;
  skippedIncompleteTracks: number;
  skippedConflictTracks: number;
  snapshotWriteAllowed: boolean;
  abstentionReason:
    | "NO_REACHABLE_MUSIC_SOURCES"
    | "INCOMPLETE_PERSISTED_SNAPSHOT"
    | "MISSING_CACHE_TIMESTAMP"
    | null;
  candidates: CacheShadowBootstrapCandidate[];
  sampleCandidates: Array<{
    spotifyTrackId: string;
    sourcePlaylistIds: string[];
    primaryArtistId: string;
    albumId: string | null;
  }>;
  sampleConflicts: Array<{
    spotifyTrackId: string;
    sourcePlaylistIds: string[];
    primaryArtistIds: string[];
    albumIds: string[];
  }>;
};

export type CacheShadowBootstrapCreatedCounts = {
  artistIdentities: number;
  artistProviderRefs: number;
  songIdentities: number;
  recordingIdentities: number;
  trackProviderRefs: number;
  albumIdentities: number;
  albumReleaseIdentities: number;
  albumReleaseProviderRefs: number;
};

export type CacheShadowBootstrapSummary = {
  gate: "2D";
  mode: "DRY_RUN" | "WRITE";
  userId: string;
  authority: {
    providerCalls: false;
    basis: "PERSISTED_SOURCE_CACHE";
    liveSpotifySnapshotVerified: false;
    plannerInfluence: false;
    cacheMutation: false;
  };
  scope: {
    enabledTargets: number;
    configuredMusicSources: number;
    enabledMusicSources: number;
    reachableMusicSources: number;
    unreachableEnabledMusicSources: number;
  };
  cache: {
    fullValidSources: number;
    partialValidSources: number;
    missingSources: number;
    invalidSources: number;
    missingCacheTimestampSources: number;
    distinctSpotifyTracks: number;
  };
  selection: {
    alreadyCanonicalOperationalTracks: number;
    excludedBackfillEligibleTracks: number;
    candidateTracks: number;
    skippedIncompleteTracks: number;
    skippedConflictTracks: number;
    snapshotWriteAllowed: boolean;
    abstentionReason: CacheShadowBootstrapPlan["abstentionReason"];
  };
  planned: {
    alreadyPresentTrackRefs: number;
    artistProviderRefsReused: number;
    artistProviderRefsToCreate: number;
    albumReleaseProviderRefsReused: number;
    albumReleaseProviderRefsToCreate: number;
    songIdentitiesToCreate: number;
    recordingIdentitiesToCreate: number;
    trackProviderRefsToCreate: number;
  };
  created: CacheShadowBootstrapCreatedCounts;
  alreadyPresentDuringWrite: number;
  projectedCoverage: {
    coveredOperationalTracksAfterWrite: number;
    basisPointsAfterWrite: number | null;
  };
  sampleCandidates: CacheShadowBootstrapPlan["sampleCandidates"];
  sampleConflicts: CacheShadowBootstrapPlan["sampleConflicts"];
};

type DecodedSource = {
  row: CacheShadowBootstrapSourceRow;
  status: "FULL_VALID" | "PARTIAL_VALID" | "MISSING" | "INVALID";
  observations: CacheShadowBootstrapObservation[];
};

export function buildCacheShadowBootstrapPlan(input: {
  sources: CacheShadowBootstrapSourceRow[];
  targets: CacheShadowBootstrapTargetRow[];
  canonicalTrackIds: ReadonlySet<string>;
  backfillEligibleTrackIds: ReadonlySet<string>;
}): CacheShadowBootstrapPlan {
  const allScopeSources = input.sources.map((source) => ({
    id: source.id,
    enabled: source.enabled,
  }));
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const reachableSourceIds = new Set<string>();

  for (const target of input.targets) {
    const resolution = resolveTargetSourceScope({
      targetPlaylistId: target.id,
      targetName: target.name,
      sourceScopeMode: target.sourceScopeMode,
      selectedSourceIds: target.sourceSelections.map((entry) => entry.sourcePlaylistId),
      sources: allScopeSources,
    });
    for (const sourceId of resolution.effectiveSourceIds) {
      if (sourceById.get(sourceId)?.kind === "MUSIC") reachableSourceIds.add(sourceId);
    }
  }

  const decoded = input.sources
    .filter((source) => source.kind === "MUSIC" && reachableSourceIds.has(source.id))
    .map(decodeSource);

  const fullValidSources = decoded.filter((source) => source.status === "FULL_VALID").length;
  const partialValidSources = decoded.filter((source) => source.status === "PARTIAL_VALID").length;
  const missingSources = decoded.filter((source) => source.status === "MISSING").length;
  const invalidSources = decoded.filter((source) => source.status === "INVALID").length;
  const missingCacheTimestampSources = decoded.filter(
    (source) =>
      (source.status === "FULL_VALID" || source.status === "PARTIAL_VALID") &&
      source.row.cacheUpdatedAt === null,
  ).length;

  let abstentionReason: CacheShadowBootstrapPlan["abstentionReason"] = null;
  if (decoded.length === 0) abstentionReason = "NO_REACHABLE_MUSIC_SOURCES";
  else if (partialValidSources > 0 || missingSources > 0 || invalidSources > 0) {
    abstentionReason = "INCOMPLETE_PERSISTED_SNAPSHOT";
  } else if (missingCacheTimestampSources > 0) {
    abstentionReason = "MISSING_CACHE_TIMESTAMP";
  }

  const byTrack = new Map<string, CacheShadowBootstrapObservation[]>();
  for (const source of decoded) {
    for (const observation of source.observations) {
      const bucket = byTrack.get(observation.spotifyTrackId) ?? [];
      bucket.push(observation);
      byTrack.set(observation.spotifyTrackId, bucket);
    }
  }

  const candidates: CacheShadowBootstrapCandidate[] = [];
  const sampleConflicts: CacheShadowBootstrapPlan["sampleConflicts"] = [];
  let alreadyCanonicalOperationalTracks = 0;
  let excludedBackfillEligibleTracks = 0;
  let skippedIncompleteTracks = 0;
  let skippedConflictTracks = 0;

  for (const [spotifyTrackId, observations] of [...byTrack.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (input.canonicalTrackIds.has(spotifyTrackId)) {
      alreadyCanonicalOperationalTracks += 1;
      continue;
    }
    if (input.backfillEligibleTrackIds.has(spotifyTrackId)) {
      excludedBackfillEligibleTracks += 1;
      continue;
    }

    const complete = observations.filter(isCompleteObservation);
    if (complete.length === 0) {
      skippedIncompleteTracks += 1;
      continue;
    }

    const artistIds = uniqueNonEmpty(complete.map((row) => row.primaryArtistId));
    const albumIds = uniqueNonEmpty(complete.map((row) => row.albumId));
    if (artistIds.length > 1 || albumIds.length > 1) {
      skippedConflictTracks += 1;
      if (sampleConflicts.length < SAMPLE_LIMIT) {
        sampleConflicts.push({
          spotifyTrackId,
          sourcePlaylistIds: unique(complete.map((row) => row.sourcePlaylistId)).sort(),
          primaryArtistIds: artistIds.sort(),
          albumIds: albumIds.sort(),
        });
      }
      continue;
    }

    const selected = [...complete].sort(compareObservationPriority)[0]!;
    const albumId = albumIds.length === 1 ? albumIds[0]! : null;
    const albumName = albumId
      ? firstNonEmpty(
          complete
            .filter((row) => clean(row.albumId) === albumId)
            .sort(compareObservationPriority)
            .map((row) => row.albumName),
        )
      : null;

    candidates.push({
      spotifyTrackId,
      spotifyUri: selected.spotifyUri,
      trackName: selected.trackName.trim(),
      primaryArtistId: selected.primaryArtistId!.trim(),
      primaryArtistName: selected.primaryArtistName!.trim(),
      albumId,
      albumName: albumId ? albumName : null,
      observedAt: selected.observedAt!,
      sourcePlaylistIds: unique(complete.map((row) => row.sourcePlaylistId)).sort(),
    });
  }

  return {
    reachableSourceIds: [...reachableSourceIds].sort(),
    fullValidSources,
    partialValidSources,
    missingSources,
    invalidSources,
    missingCacheTimestampSources,
    distinctSpotifyTracks: byTrack.size,
    alreadyCanonicalOperationalTracks,
    excludedBackfillEligibleTracks,
    candidateTracks: candidates.length,
    skippedIncompleteTracks,
    skippedConflictTracks,
    snapshotWriteAllowed: abstentionReason === null,
    abstentionReason,
    candidates,
    sampleCandidates: candidates.slice(0, SAMPLE_LIMIT).map((candidate) => ({
      spotifyTrackId: candidate.spotifyTrackId,
      sourcePlaylistIds: candidate.sourcePlaylistIds,
      primaryArtistId: candidate.primaryArtistId,
      albumId: candidate.albumId,
    })),
    sampleConflicts,
  };
}

export async function runMusicIdentityCacheShadowBootstrap(input: {
  userId: string;
  write?: boolean;
}): Promise<CacheShadowBootstrapSummary> {
  const userId = clean(input.userId);
  if (!userId) throw new Error("userId is required");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new Error(`Sonoriza user not found: ${userId}`);

  const [sources, targets, canonicalRefs, backfillEligibleTrackIds] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        kind: true,
        enabled: true,
        cachedCandidates: true,
        spotifySnapshotId: true,
        cacheUpdatedAt: true,
      },
    }),
    prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      select: {
        id: true,
        name: true,
        sourceScopeMode: true,
        sourceSelections: { select: { sourcePlaylistId: true } },
      },
    }),
    prisma.trackProviderRef.findMany({
      where: { userId, provider: SPOTIFY_PROVIDER },
      select: { providerTrackId: true },
    }),
    loadGate2BEligibleTrackIds(userId),
  ]);

  const configuredMusicSources = sources.filter((source) => source.kind === "MUSIC");
  const enabledMusicSources = configuredMusicSources.filter((source) => source.enabled);
  const canonicalTrackIds = new Set(canonicalRefs.map((row) => row.providerTrackId));
  const plan = buildCacheShadowBootstrapPlan({
    sources,
    targets,
    canonicalTrackIds,
    backfillEligibleTrackIds,
  });

  if (input.write && !plan.snapshotWriteAllowed) {
    throw new Error(`Gate 2D write aborted: ${plan.abstentionReason}`);
  }

  const preview = await previewPersistence(userId, plan.candidates);
  const created = emptyCreatedCounts();
  let alreadyPresentDuringWrite = 0;

  if (input.write && plan.candidates.length > 0) {
    const persisted = await persistCandidates(userId, plan.candidates);
    alreadyPresentDuringWrite = persisted.alreadyPresentTrackRefs;
    Object.assign(created, persisted.created);
  }

  const coveredAfterWrite = Math.min(
    plan.distinctSpotifyTracks,
    plan.alreadyCanonicalOperationalTracks +
      (input.write ? created.trackProviderRefs : preview.trackProviderRefsToCreate),
  );

  return {
    gate: "2D",
    mode: input.write ? "WRITE" : "DRY_RUN",
    userId,
    authority: {
      providerCalls: false,
      basis: "PERSISTED_SOURCE_CACHE",
      liveSpotifySnapshotVerified: false,
      plannerInfluence: false,
      cacheMutation: false,
    },
    scope: {
      enabledTargets: targets.length,
      configuredMusicSources: configuredMusicSources.length,
      enabledMusicSources: enabledMusicSources.length,
      reachableMusicSources: plan.reachableSourceIds.length,
      unreachableEnabledMusicSources: enabledMusicSources.filter(
        (source) => !plan.reachableSourceIds.includes(source.id),
      ).length,
    },
    cache: {
      fullValidSources: plan.fullValidSources,
      partialValidSources: plan.partialValidSources,
      missingSources: plan.missingSources,
      invalidSources: plan.invalidSources,
      missingCacheTimestampSources: plan.missingCacheTimestampSources,
      distinctSpotifyTracks: plan.distinctSpotifyTracks,
    },
    selection: {
      alreadyCanonicalOperationalTracks: plan.alreadyCanonicalOperationalTracks,
      excludedBackfillEligibleTracks: plan.excludedBackfillEligibleTracks,
      candidateTracks: plan.candidateTracks,
      skippedIncompleteTracks: plan.skippedIncompleteTracks,
      skippedConflictTracks: plan.skippedConflictTracks,
      snapshotWriteAllowed: plan.snapshotWriteAllowed,
      abstentionReason: plan.abstentionReason,
    },
    planned: preview,
    created,
    alreadyPresentDuringWrite,
    projectedCoverage: {
      coveredOperationalTracksAfterWrite: coveredAfterWrite,
      basisPointsAfterWrite:
        plan.distinctSpotifyTracks === 0
          ? null
          : Math.round((coveredAfterWrite / plan.distinctSpotifyTracks) * 10_000),
    },
    sampleCandidates: plan.sampleCandidates,
    sampleConflicts: plan.sampleConflicts,
  };
}

async function loadGate2BEligibleTrackIds(userId: string): Promise<Set<string>> {
  const [likedRows, eventRows] = await Promise.all([
    prisma.likedTrackPreference.findMany({
      where: { userId, isLiked: true, availability: "AVAILABLE" },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        primaryArtistId: true,
        primaryArtistName: true,
        albumId: true,
        albumName: true,
        lastObservedAt: true,
      },
    }),
    prisma.trackListeningEvent.findMany({
      where: {
        userId,
        source: { in: ["SPOTIFY_RECENTLY_PLAYED", "SPOTIFY_EXTENDED_HISTORY"] },
        spotifyTrackId: { not: null },
      },
      orderBy: { playedAt: "desc" },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        artistName: true,
        primaryArtistId: true,
        albumId: true,
        albumName: true,
        isrc: true,
        trackMbid: true,
        playedAt: true,
      },
    }),
  ]);

  const observations: ShadowBackfillObservation[] = [
    ...likedRows.map((row) => ({
      source: "LIKED_TRACK_PREFERENCE" as const,
      observedAt: row.lastObservedAt,
      spotifyTrackId: row.spotifyTrackId,
      spotifyUri: row.spotifyUri,
      trackName: row.trackName,
      primaryArtistId: row.primaryArtistId,
      primaryArtistName: row.primaryArtistName,
      albumId: row.albumId,
      albumName: row.albumName,
      isrc: null,
      trackMbid: null,
    })),
    ...eventRows.map((row) => ({
      source: "SPOTIFY_LISTENING_EVENT" as const,
      observedAt: row.playedAt,
      spotifyTrackId: row.spotifyTrackId,
      spotifyUri: row.spotifyUri,
      trackName: row.trackName,
      primaryArtistId: row.primaryArtistId,
      primaryArtistName: row.artistName,
      albumId: row.albumId,
      albumName: row.albumName,
      isrc: row.isrc,
      trackMbid: row.trackMbid,
    })),
  ];

  return new Set(
    buildShadowBackfillCandidates(observations).candidates.map(
      (candidate) => candidate.spotifyTrackId,
    ),
  );
}

async function previewPersistence(
  userId: string,
  candidates: CacheShadowBootstrapCandidate[],
): Promise<CacheShadowBootstrapSummary["planned"]> {
  if (candidates.length === 0) return emptyPlannedCounts();

  const [existingTracks, existingArtists, existingAlbums] = await Promise.all([
    prisma.trackProviderRef.findMany({
      where: {
        userId,
        provider: SPOTIFY_PROVIDER,
        providerTrackId: { in: candidates.map((candidate) => candidate.spotifyTrackId) },
      },
      select: { providerTrackId: true },
    }),
    prisma.artistProviderRef.findMany({
      where: {
        userId,
        provider: SPOTIFY_PROVIDER,
        providerArtistId: { in: unique(candidates.map((candidate) => candidate.primaryArtistId)) },
      },
      select: { providerArtistId: true },
    }),
    prisma.albumReleaseProviderRef.findMany({
      where: {
        userId,
        provider: SPOTIFY_PROVIDER,
        providerAlbumId: {
          in: unique(
            candidates
              .map((candidate) => candidate.albumId)
              .filter((value): value is string => Boolean(value)),
          ),
        },
      },
      select: { providerAlbumId: true },
    }),
  ]);

  const existingTrackIds = new Set(existingTracks.map((row) => row.providerTrackId));
  const pending = candidates.filter((candidate) => !existingTrackIds.has(candidate.spotifyTrackId));
  const existingArtistIds = new Set(existingArtists.map((row) => row.providerArtistId));
  const existingAlbumIds = new Set(existingAlbums.map((row) => row.providerAlbumId));
  const pendingArtistIds = unique(pending.map((candidate) => candidate.primaryArtistId));
  const pendingAlbumIds = unique(
    pending
      .map((candidate) => candidate.albumId)
      .filter((value): value is string => Boolean(value)),
  );

  return {
    alreadyPresentTrackRefs: candidates.length - pending.length,
    artistProviderRefsReused: pendingArtistIds.filter((id) => existingArtistIds.has(id)).length,
    artistProviderRefsToCreate: pendingArtistIds.filter((id) => !existingArtistIds.has(id)).length,
    albumReleaseProviderRefsReused: pendingAlbumIds.filter((id) => existingAlbumIds.has(id)).length,
    albumReleaseProviderRefsToCreate: pendingAlbumIds.filter((id) => !existingAlbumIds.has(id)).length,
    songIdentitiesToCreate: pending.length,
    recordingIdentitiesToCreate: pending.length,
    trackProviderRefsToCreate: pending.length,
  };
}

async function persistCandidates(
  userId: string,
  candidates: CacheShadowBootstrapCandidate[],
): Promise<{
  alreadyPresentTrackRefs: number;
  created: CacheShadowBootstrapCreatedCounts;
}> {
  const created = emptyCreatedCounts();
  let alreadyPresentTrackRefs = 0;

  for (const candidate of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.trackProviderRef.findUnique({
        where: {
          userId_provider_providerTrackId: {
            userId,
            provider: SPOTIFY_PROVIDER,
            providerTrackId: candidate.spotifyTrackId,
          },
        },
        select: { id: true },
      });
      if (existing) return { alreadyPresent: true, created: emptyCreatedCounts() };

      const delta = emptyCreatedCounts();
      let artistRef = await tx.artistProviderRef.findUnique({
        where: {
          userId_provider_providerArtistId: {
            userId,
            provider: SPOTIFY_PROVIDER,
            providerArtistId: candidate.primaryArtistId,
          },
        },
        select: { artistIdentityId: true },
      });

      if (!artistRef) {
        const artist = await tx.artistIdentity.create({
          data: { userId, canonicalName: candidate.primaryArtistName },
          select: { id: true },
        });
        delta.artistIdentities += 1;
        artistRef = await tx.artistProviderRef.create({
          data: {
            userId,
            artistIdentityId: artist.id,
            provider: SPOTIFY_PROVIDER,
            providerArtistId: candidate.primaryArtistId,
            matchReason: MATCH_REASON,
            confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
            resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
            observedAt: candidate.observedAt,
          },
          select: { artistIdentityId: true },
        });
        delta.artistProviderRefs += 1;
      }

      const song = await tx.songIdentity.create({
        data: {
          userId,
          primaryArtistIdentityId: artistRef.artistIdentityId,
          canonicalTitle: candidate.trackName,
        },
        select: { id: true },
      });
      delta.songIdentities += 1;

      const recording = await tx.recordingIdentity.create({
        data: { userId, songIdentityId: song.id },
        select: { id: true },
      });
      delta.recordingIdentities += 1;

      await tx.trackProviderRef.create({
        data: {
          userId,
          recordingIdentityId: recording.id,
          provider: SPOTIFY_PROVIDER,
          providerTrackId: candidate.spotifyTrackId,
          uri: candidate.spotifyUri,
          isrc: null,
          trackMbid: null,
          executionStatus: "KNOWN",
          matchReason: MATCH_REASON,
          confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
          resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
          observedAt: candidate.observedAt,
        },
      });
      delta.trackProviderRefs += 1;

      if (candidate.albumId && candidate.albumName) {
        const existingAlbumRef = await tx.albumReleaseProviderRef.findUnique({
          where: {
            userId_provider_providerAlbumId: {
              userId,
              provider: SPOTIFY_PROVIDER,
              providerAlbumId: candidate.albumId,
            },
          },
          select: { id: true },
        });

        if (!existingAlbumRef) {
          const album = await tx.albumIdentity.create({
            data: { userId, canonicalTitle: candidate.albumName },
            select: { id: true },
          });
          delta.albumIdentities += 1;

          const release = await tx.albumReleaseIdentity.create({
            data: { userId, albumIdentityId: album.id },
            select: { id: true },
          });
          delta.albumReleaseIdentities += 1;

          await tx.albumReleaseProviderRef.create({
            data: {
              userId,
              albumReleaseIdentityId: release.id,
              provider: SPOTIFY_PROVIDER,
              providerAlbumId: candidate.albumId,
              matchReason: MATCH_REASON,
              confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
              resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
              observedAt: candidate.observedAt,
            },
          });
          delta.albumReleaseProviderRefs += 1;
        }
      }

      return { alreadyPresent: false, created: delta };
    });

    if (result.alreadyPresent) alreadyPresentTrackRefs += 1;
    addCreatedCounts(created, result.created);
  }

  return { alreadyPresentTrackRefs, created };
}

function decodeSource(row: CacheShadowBootstrapSourceRow): DecodedSource {
  const full = decodeMusicSourceCache(row.cachedCandidates);
  if (full !== null) {
    return {
      row,
      status: "FULL_VALID",
      observations: full.map((candidate) => toObservation(row, candidate)),
    };
  }

  const partial = decodePartialMusicSourceCache(row.cachedCandidates);
  if (partial !== null) {
    return {
      row,
      status: "PARTIAL_VALID",
      observations: partial.candidates.map((candidate) => toObservation(row, candidate)),
    };
  }

  return {
    row,
    status: row.cachedCandidates == null ? "MISSING" : "INVALID",
    observations: [],
  };
}

function toObservation(
  row: CacheShadowBootstrapSourceRow,
  candidate: {
    uri: string;
    spotifyTrackId?: string;
    title: string;
    primaryArtistId?: string;
    primaryArtistName?: string;
    albumId?: string;
    albumName?: string;
  },
): CacheShadowBootstrapObservation {
  return {
    sourcePlaylistId: row.id,
    observedAt: row.cacheUpdatedAt,
    spotifyTrackId: candidate.spotifyTrackId!,
    spotifyUri: candidate.uri,
    trackName: candidate.title,
    primaryArtistId: candidate.primaryArtistId ?? null,
    primaryArtistName: candidate.primaryArtistName ?? null,
    albumId: candidate.albumId ?? null,
    albumName: candidate.albumName ?? null,
  };
}

function isCompleteObservation(observation: CacheShadowBootstrapObservation): boolean {
  return Boolean(
    observation.observedAt &&
      clean(observation.spotifyTrackId) &&
      clean(observation.spotifyUri) &&
      clean(observation.trackName) &&
      clean(observation.primaryArtistId) &&
      clean(observation.primaryArtistName),
  );
}

function compareObservationPriority(
  a: CacheShadowBootstrapObservation,
  b: CacheShadowBootstrapObservation,
): number {
  const time = (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0);
  if (time !== 0) return time;
  return a.sourcePlaylistId.localeCompare(b.sourcePlaylistId);
}

function spotifyLineage(): DataLineage {
  return { origins: ["SPOTIFY"] };
}

function emptyCreatedCounts(): CacheShadowBootstrapCreatedCounts {
  return {
    artistIdentities: 0,
    artistProviderRefs: 0,
    songIdentities: 0,
    recordingIdentities: 0,
    trackProviderRefs: 0,
    albumIdentities: 0,
    albumReleaseIdentities: 0,
    albumReleaseProviderRefs: 0,
  };
}

function emptyPlannedCounts(): CacheShadowBootstrapSummary["planned"] {
  return {
    alreadyPresentTrackRefs: 0,
    artistProviderRefsReused: 0,
    artistProviderRefsToCreate: 0,
    albumReleaseProviderRefsReused: 0,
    albumReleaseProviderRefsToCreate: 0,
    songIdentitiesToCreate: 0,
    recordingIdentitiesToCreate: 0,
    trackProviderRefsToCreate: 0,
  };
}

function addCreatedCounts(
  target: CacheShadowBootstrapCreatedCounts,
  delta: CacheShadowBootstrapCreatedCounts,
): void {
  for (const key of Object.keys(target) as Array<keyof CacheShadowBootstrapCreatedCounts>) {
    target[key] += delta[key];
  }
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function firstNonEmpty(values: Array<string | null>): string | null {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return null;
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return unique(
    values.map((value) => clean(value)).filter((value): value is string => Boolean(value)),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
