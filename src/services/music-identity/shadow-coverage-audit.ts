import { prisma } from "@/lib/prisma";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  decodeMusicSourceCache,
  decodeMusicSourceCacheUnavailableTrackCount,
  decodePartialMusicSourceCache,
} from "@/services/spotify/source-cache";

import {
  buildShadowBackfillCandidates,
  type ShadowBackfillObservation,
} from "./shadow-backfill";

const SPOTIFY_PROVIDER = "spotify";
const SAMPLE_LIMIT = 50;

export type ShadowCoverageCacheStatus =
  | "FULL_VALID"
  | "PARTIAL_VALID"
  | "MISSING"
  | "INVALID";

export type ShadowCoverageSourceRow = {
  id: string;
  name: string | null;
  kind: "MUSIC" | "PODCAST";
  enabled: boolean;
  cachedCandidates: unknown;
  spotifySnapshotId: string | null;
  cacheUpdatedAt: Date | null;
};

export type ShadowCoverageTargetRow = {
  id: string;
  name: string;
  sourceScopeMode: "INHERIT_GLOBAL" | "SELECTED_ONLY";
  sourceSelections: Array<{ sourcePlaylistId: string }>;
};

export type ShadowCoverageCanonicalRefRow = {
  providerTrackId: string;
  executionStatus: "KNOWN" | "EXECUTABLE" | "UNAVAILABLE";
};

export type ShadowCoverageInput = {
  userId: string;
  sources: ShadowCoverageSourceRow[];
  targets: ShadowCoverageTargetRow[];
  canonicalRefs: ShadowCoverageCanonicalRefRow[];
  backfillEligibleTrackIds: ReadonlySet<string>;
};

export type ShadowCoverageSummary = {
  gate: "2C";
  mode: "SHADOW_READ_ONLY";
  userId: string;
  authority: {
    providerCalls: false;
    writes: false;
    basis: "PERSISTED_SOURCE_CACHE";
    liveSpotifySnapshotVerified: false;
    interpretation: "COMPLETE_PERSISTED_SNAPSHOT" | "LOWER_BOUND_PARTIAL_OR_UNAVAILABLE";
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
    candidateOccurrences: number;
    distinctSpotifyTracks: number;
    duplicateOccurrencesAcrossSources: number;
    unavailableTrackCount: number;
  };
  canonical: {
    trackProviderRefs: number;
    known: number;
    executable: number;
    unavailable: number;
  };
  coverage: {
    coveredDistinctTracks: number;
    missingCanonicalDistinctTracks: number;
    canonicalOutsidePersistedCache: number;
    basisPoints: number | null;
  };
  gaps: {
    backfillEligibleTracks: number;
    cacheOnlyBootstrapReadyTracks: number;
    incompleteArtistMetadataTracks: number;
  };
  sources: Array<{
    sourcePlaylistId: string;
    sourceName: string | null;
    cacheStatus: ShadowCoverageCacheStatus;
    spotifySnapshotPersisted: boolean;
    cacheUpdatedAt: string | null;
    candidateCount: number;
    distinctSpotifyTracks: number;
    coveredTracks: number;
    missingCanonicalTracks: number;
    unavailableTrackCount: number;
  }>;
  sampleMissing: Array<{
    spotifyTrackId: string;
    sourcePlaylistIds: string[];
    backfillEligible: boolean;
    bootstrapReadyFromCache: boolean;
    missingMetadata: string[];
  }>;
};

type DecodedSource = {
  row: ShadowCoverageSourceRow;
  cacheStatus: ShadowCoverageCacheStatus;
  unavailableTrackCount: number;
  candidates: Array<{
    spotifyTrackId: string;
    title: string;
    primaryArtistId?: string;
    primaryArtistName?: string;
  }>;
};

export function buildMusicIdentityShadowCoverage(
  input: ShadowCoverageInput,
): ShadowCoverageSummary {
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
      if (sourceById.get(sourceId)?.kind === "MUSIC") {
        reachableSourceIds.add(sourceId);
      }
    }
  }

  const configuredMusicSources = input.sources.filter((source) => source.kind === "MUSIC");
  const enabledMusicSources = configuredMusicSources.filter((source) => source.enabled);
  const reachableSources = configuredMusicSources
    .filter((source) => reachableSourceIds.has(source.id))
    .map(decodePersistedSource);

  const canonicalByTrackId = new Map(
    input.canonicalRefs.map((ref) => [ref.providerTrackId, ref]),
  );
  const canonicalIds = new Set(canonicalByTrackId.keys());

  const occurrencesByTrackId = new Map<
    string,
    Array<{
      sourceId: string;
      title: string;
      primaryArtistId?: string;
      primaryArtistName?: string;
    }>
  >();

  for (const source of reachableSources) {
    for (const candidate of source.candidates) {
      const bucket = occurrencesByTrackId.get(candidate.spotifyTrackId) ?? [];
      bucket.push({
        sourceId: source.row.id,
        title: candidate.title,
        primaryArtistId: candidate.primaryArtistId,
        primaryArtistName: candidate.primaryArtistName,
      });
      occurrencesByTrackId.set(candidate.spotifyTrackId, bucket);
    }
  }

  const operationalIds = new Set(occurrencesByTrackId.keys());
  const coveredIds = [...operationalIds].filter((id) => canonicalIds.has(id));
  const missingIds = [...operationalIds].filter((id) => !canonicalIds.has(id));
  const canonicalOutside = [...canonicalIds].filter((id) => !operationalIds.has(id));

  let gapBackfillEligible = 0;
  let gapCacheBootstrapReady = 0;
  let gapIncompleteArtistMetadata = 0;
  const sampleMissing: ShadowCoverageSummary["sampleMissing"] = [];

  for (const trackId of missingIds.sort()) {
    const occurrences = occurrencesByTrackId.get(trackId) ?? [];
    const backfillEligible = input.backfillEligibleTrackIds.has(trackId);
    const bootstrapReadyFromCache = occurrences.some(
      (occurrence) =>
        Boolean(occurrence.title) &&
        Boolean(occurrence.primaryArtistId) &&
        Boolean(occurrence.primaryArtistName),
    );

    if (backfillEligible) gapBackfillEligible += 1;
    else if (bootstrapReadyFromCache) gapCacheBootstrapReady += 1;
    else gapIncompleteArtistMetadata += 1;

    if (sampleMissing.length < SAMPLE_LIMIT) {
      const missingMetadata = new Set<string>();
      if (!occurrences.some((entry) => Boolean(entry.primaryArtistId))) {
        missingMetadata.add("primaryArtistId");
      }
      if (!occurrences.some((entry) => Boolean(entry.primaryArtistName))) {
        missingMetadata.add("primaryArtistName");
      }
      sampleMissing.push({
        spotifyTrackId: trackId,
        sourcePlaylistIds: [...new Set(occurrences.map((entry) => entry.sourceId))].sort(),
        backfillEligible,
        bootstrapReadyFromCache,
        missingMetadata: [...missingMetadata].sort(),
      });
    }
  }

  const sourceSummaries = reachableSources.map((source) => {
    const ids = new Set(source.candidates.map((candidate) => candidate.spotifyTrackId));
    const covered = [...ids].filter((id) => canonicalIds.has(id)).length;
    return {
      sourcePlaylistId: source.row.id,
      sourceName: source.row.name,
      cacheStatus: source.cacheStatus,
      spotifySnapshotPersisted: Boolean(source.row.spotifySnapshotId),
      cacheUpdatedAt: source.row.cacheUpdatedAt?.toISOString() ?? null,
      candidateCount: source.candidates.length,
      distinctSpotifyTracks: ids.size,
      coveredTracks: covered,
      missingCanonicalTracks: ids.size - covered,
      unavailableTrackCount: source.unavailableTrackCount,
    };
  });

  const fullValidSources = reachableSources.filter(
    (source) => source.cacheStatus === "FULL_VALID",
  ).length;
  const partialValidSources = reachableSources.filter(
    (source) => source.cacheStatus === "PARTIAL_VALID",
  ).length;
  const missingSources = reachableSources.filter(
    (source) => source.cacheStatus === "MISSING",
  ).length;
  const invalidSources = reachableSources.filter(
    (source) => source.cacheStatus === "INVALID",
  ).length;
  const candidateOccurrences = reachableSources.reduce(
    (sum, source) => sum + source.candidates.length,
    0,
  );
  const unavailableTrackCount = reachableSources.reduce(
    (sum, source) => sum + source.unavailableTrackCount,
    0,
  );
  const persistedComplete =
    reachableSources.length > 0 &&
    partialValidSources === 0 &&
    missingSources === 0 &&
    invalidSources === 0;

  return {
    gate: "2C",
    mode: "SHADOW_READ_ONLY",
    userId: input.userId,
    authority: {
      providerCalls: false,
      writes: false,
      basis: "PERSISTED_SOURCE_CACHE",
      liveSpotifySnapshotVerified: false,
      interpretation: persistedComplete
        ? "COMPLETE_PERSISTED_SNAPSHOT"
        : "LOWER_BOUND_PARTIAL_OR_UNAVAILABLE",
    },
    scope: {
      enabledTargets: input.targets.length,
      configuredMusicSources: configuredMusicSources.length,
      enabledMusicSources: enabledMusicSources.length,
      reachableMusicSources: reachableSources.length,
      unreachableEnabledMusicSources: enabledMusicSources.filter(
        (source) => !reachableSourceIds.has(source.id),
      ).length,
    },
    cache: {
      fullValidSources,
      partialValidSources,
      missingSources,
      invalidSources,
      candidateOccurrences,
      distinctSpotifyTracks: operationalIds.size,
      duplicateOccurrencesAcrossSources: Math.max(0, candidateOccurrences - operationalIds.size),
      unavailableTrackCount,
    },
    canonical: {
      trackProviderRefs: input.canonicalRefs.length,
      known: input.canonicalRefs.filter((ref) => ref.executionStatus === "KNOWN").length,
      executable: input.canonicalRefs.filter((ref) => ref.executionStatus === "EXECUTABLE").length,
      unavailable: input.canonicalRefs.filter((ref) => ref.executionStatus === "UNAVAILABLE").length,
    },
    coverage: {
      coveredDistinctTracks: coveredIds.length,
      missingCanonicalDistinctTracks: missingIds.length,
      canonicalOutsidePersistedCache: canonicalOutside.length,
      basisPoints:
        operationalIds.size === 0
          ? null
          : Math.round((coveredIds.length / operationalIds.size) * 10_000),
    },
    gaps: {
      backfillEligibleTracks: gapBackfillEligible,
      cacheOnlyBootstrapReadyTracks: gapCacheBootstrapReady,
      incompleteArtistMetadataTracks: gapIncompleteArtistMetadata,
    },
    sources: sourceSummaries.sort((a, b) =>
      a.sourcePlaylistId.localeCompare(b.sourcePlaylistId),
    ),
    sampleMissing,
  };
}

export async function runMusicIdentityShadowCoverageAudit(userIdInput: string): Promise<ShadowCoverageSummary> {
  const userId = userIdInput.trim();
  if (!userId) throw new Error("userId is required");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) throw new Error(`Sonoriza user not found: ${userId}`);

  const [sources, targets, canonicalRefs, likedRows, eventRows] = await Promise.all([
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
        sourceSelections: {
          select: { sourcePlaylistId: true },
        },
      },
    }),
    prisma.trackProviderRef.findMany({
      where: { userId, provider: SPOTIFY_PROVIDER },
      select: {
        providerTrackId: true,
        executionStatus: true,
      },
    }),
    prisma.likedTrackPreference.findMany({
      where: {
        userId,
        isLiked: true,
        availability: "AVAILABLE",
      },
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
        source: {
          in: ["SPOTIFY_RECENTLY_PLAYED", "SPOTIFY_EXTENDED_HISTORY"],
        },
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
  const backfillEligible = buildShadowBackfillCandidates(observations);

  return buildMusicIdentityShadowCoverage({
    userId,
    sources: sources.map((source) => ({
      ...source,
      cachedCandidates: source.cachedCandidates,
    })),
    targets,
    canonicalRefs,
    backfillEligibleTrackIds: new Set(
      backfillEligible.candidates.map((candidate) => candidate.spotifyTrackId),
    ),
  });
}

function decodePersistedSource(row: ShadowCoverageSourceRow): DecodedSource {
  const full = decodeMusicSourceCache(row.cachedCandidates);
  if (full !== null) {
    return {
      row,
      cacheStatus: "FULL_VALID",
      unavailableTrackCount:
        decodeMusicSourceCacheUnavailableTrackCount(row.cachedCandidates) ?? 0,
      candidates: full.map(toCoverageCandidate),
    };
  }

  const partial = decodePartialMusicSourceCache(row.cachedCandidates);
  if (partial !== null) {
    return {
      row,
      cacheStatus: "PARTIAL_VALID",
      unavailableTrackCount: partial.unavailableTrackCount,
      candidates: partial.candidates.map(toCoverageCandidate),
    };
  }

  return {
    row,
    cacheStatus: row.cachedCandidates == null ? "MISSING" : "INVALID",
    unavailableTrackCount: 0,
    candidates: [],
  };
}

function toCoverageCandidate(candidate: {
  spotifyTrackId?: string;
  title: string;
  primaryArtistId?: string;
  primaryArtistName?: string;
}) {
  return {
    spotifyTrackId: candidate.spotifyTrackId!,
    title: candidate.title,
    primaryArtistId: candidate.primaryArtistId,
    primaryArtistName: candidate.primaryArtistName,
  };
}
