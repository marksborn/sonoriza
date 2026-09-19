import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  classifyTrackVersion,
  type TrackVersionClassification,
} from "@/services/music-discovery/track-version-preference";
import {
  decodeMusicSourceCache,
  decodePartialMusicSourceCache,
} from "@/services/spotify/source-cache";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  normalizeIsrcEvidence,
  type IdentityMatchReason,
  type IdentityResolutionStatus,
} from "./contracts";

const SPOTIFY_PROVIDER = "spotify";
const GLOBAL_PROVIDER_SCOPE = "global";
const SAMPLE_LIMIT = 25;

type CacheStatus = "FULL_VALID" | "PARTIAL_VALID" | "MISSING" | "INVALID";

export type ShadowResolverVersionTrait =
  | "STANDARD"
  | "LIVE"
  | "ACOUSTIC"
  | "REMIX"
  | "DEMO"
  | "REMASTER"
  | "UNKNOWN";

export type ShadowResolverTrackRow = {
  provider: string;
  providerScope: string;
  providerTrackId: string;
  recordingIdentityId: string;
  songIdentityId: string;
  primaryArtistIdentityId: string;
  primaryArtistProviderId: string | null;
  primaryArtistName: string;
  trackName: string | null;
  albumProviderId: string | null;
  albumName: string | null;
  durationMs: number | null;
  isrc: string | null;
  trackMbid: string | null;
  sourcePlaylistIds: string[];
};

export type ShadowResolverPair = {
  left: ShadowResolverTrackSummary;
  right: ShadowResolverTrackSummary;
  resolution: {
    status: IdentityResolutionStatus;
    reason: IdentityMatchReason;
    level: "RECORDING" | "SONG_ONLY" | "NONE";
    action:
      | "ALREADY_LINKED"
      | "REVIEW_RECORDING_MERGE"
      | "KEEP_RECORDINGS_SEPARATE"
      | "REVIEW_ONLY";
    confidenceBasisPoints: number;
  };
  evidence: {
    sameCanonicalRecording: boolean;
    sameIsrc: boolean;
    sameTrackMbid: boolean;
    samePrimaryArtistProviderId: boolean;
    sameBaseTitleSignal: boolean;
    durationDeltaMs: number | null;
    leftVersionTrait: ShadowResolverVersionTrait;
    rightVersionTrait: ShadowResolverVersionTrait;
  };
};

type ShadowResolverTrackSummary = {
  provider: string;
  providerScope: string;
  providerTrackId: string;
  recordingIdentityId: string;
  primaryArtistProviderId: string | null;
  primaryArtistName: string;
  trackName: string | null;
  albumProviderId: string | null;
  albumName: string | null;
  durationMs: number | null;
};

type CrossArtistCollisionGroup = {
  baseTitleSignal: string;
  distinctArtistProviderIds: number;
  trackCount: number;
  sampleTracks: Array<{
    providerTrackId: string;
    primaryArtistProviderId: string;
    primaryArtistName: string;
    trackName: string | null;
  }>;
};

type AlbumEditionGroup = {
  primaryArtistProviderId: string;
  primaryArtistName: string;
  baseAlbumTitleSignal: string;
  albumCount: number;
  albums: Array<{
    albumProviderId: string;
    albumName: string;
    editionTrait: string;
  }>;
};

export type MusicIdentityShadowResolverReport = {
  gate: "3";
  mode: "SHADOW_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: false;
    writes: false;
    basis: "PERSISTED_CANONICAL_GRAPH_PLUS_SOURCE_CACHE";
    liveProviderSnapshotVerified: false;
    interpretation: "COMPLETE_PERSISTED_SNAPSHOT" | "LOWER_BOUND_PERSISTED_SNAPSHOT";
  };
  safety: {
    plannerInfluence: false;
    identityMutation: false;
    consumerActivation: false;
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
    distinctSpotifyTracks: number;
  };
  canonical: {
    trackProviderRefs: number;
    spotifyGlobalTrackProviderRefs: number;
    cacheEnrichedTrackProviderRefs: number;
    canonicalOutsidePersistedCache: number;
  };
  evidence: {
    exactAliasGroups: number;
    sameIsrcGroups: number;
    sameTrackMbidGroups: number;
    crossArtistTitleCollisionGroups: number;
    albumEditionGroups: number;
  };
  resolution: {
    pairCount: number;
    exactProviderAliasPairs: number;
    sameRecordingHighConfidencePairs: number;
    sameSongDifferentRecordingPairs: number;
    textualPossibleMatchPairs: number;
    ambiguousPairs: number;
    liveVsStudioPairs: number;
    remasterPairs: number;
    acousticPairs: number;
    remixPairs: number;
    demoPairs: number;
    confidence: {
      high: number;
      medium: number;
      low: number;
    };
    pairs: ShadowResolverPair[];
  };
  guards: {
    crossArtistTitleCollisions: CrossArtistCollisionGroup[];
    albumEditionCandidates: AlbumEditionGroup[];
  };
};

type BuildReportContext = {
  userId: string;
  enabledTargets?: number;
  configuredMusicSources?: number;
  enabledMusicSources?: number;
  reachableMusicSources?: number;
  unreachableEnabledMusicSources?: number;
  fullValidSources?: number;
  partialValidSources?: number;
  missingSources?: number;
  invalidSources?: number;
  distinctSpotifyTracks?: number;
};

type PairAccumulator = {
  left: ShadowResolverTrackRow;
  right: ShadowResolverTrackRow;
  sameCanonicalRecording: boolean;
  sameIsrc: boolean;
  sameTrackMbid: boolean;
  sameTextualSignal: boolean;
};

const TRACK_QUALIFIER_STRIPPERS = [
  /\s*[-–—:]\s*(?:live(?:\s+(?:at|from|in)\b.*|\b.*)?|ao\s+vivo\b.*|en\s+vivo\b.*|in\s+concert\b.*)\s*$/i,
  /\s*[\[(]\s*(?:live(?:\s+(?:at|from|in)\b.*|\b.*)?|ao\s+vivo\b.*|en\s+vivo\b.*|in\s+concert\b.*)\s*[\])]\s*$/i,
  /\s*[-–—:]\s*[^()[\]]{0,60}\b(?:remix|acoustic|acústic[oa]|demo|remaster(?:ed)?)\b[^()[\]]{0,60}\s*$/i,
  /\s*[\[(]\s*[^\])]{0,60}\b(?:remix|acoustic|acústic[oa]|demo|remaster(?:ed)?)\b[^\])]{0,60}\s*[\])]\s*$/i,
] as const;

const ALBUM_EDITION_STRIPPERS = [
  /\s*[-–—:]\s*[^()[\]]{0,80}\b(?:deluxe|expanded|anniversary|special\s+edition|remaster(?:ed)?)\b[^()[\]]{0,80}\s*$/i,
  /\s*[\[(]\s*[^\])]{0,80}\b(?:deluxe|expanded|anniversary|special\s+edition|remaster(?:ed)?)\b[^\])]{0,80}\s*[\])]\s*$/i,
] as const;

export function deriveBaseTitleSignal(value: string | null | undefined): string | null {
  let normalized = normalizeText(value);
  if (!normalized) return null;

  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    for (const pattern of TRACK_QUALIFIER_STRIPPERS) {
      const stripped = normalized.replace(pattern, "").trim();
      if (stripped && stripped !== normalized) {
        normalized = stripped;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  return comparisonText(normalized);
}

export function deriveBaseAlbumTitleSignal(value: string | null | undefined): string | null {
  let normalized = normalizeText(value);
  if (!normalized) return null;

  for (const pattern of ALBUM_EDITION_STRIPPERS) {
    const stripped = normalized.replace(pattern, "").trim();
    if (stripped && stripped !== normalized) {
      normalized = stripped;
      break;
    }
  }

  return comparisonText(normalized);
}

export function classifyShadowResolverVersion(input: {
  trackName: string | null | undefined;
  albumName?: string | null | undefined;
}): ShadowResolverVersionTrait {
  const live = classifyTrackVersion(input);
  if (live.classification === "LIVE") return "LIVE";

  const track = normalizeText(input.trackName);
  const album = normalizeText(input.albumName);
  if (!track && !album) return "UNKNOWN";

  if (hasVersionQualifier(track, /\bremix\b/i)) return "REMIX";
  if (hasVersionQualifier(track, /\b(?:acoustic|acústic[oa])\b/i)) return "ACOUSTIC";
  if (hasVersionQualifier(track, /\bdemo\b/i)) return "DEMO";
  if (
    hasVersionQualifier(track, /\bremaster(?:ed)?\b/i) ||
    hasEditionQualifier(album, /\bremaster(?:ed)?\b/i)
  ) {
    return "REMASTER";
  }

  return track ? "STANDARD" : "UNKNOWN";
}

export function buildMusicIdentityShadowResolverReport(
  rowsInput: readonly ShadowResolverTrackRow[],
  context: BuildReportContext,
): MusicIdentityShadowResolverReport {
  const rows = [...rowsInput].sort(compareRows);
  const pairMap = new Map<string, PairAccumulator>();

  const exactAliasGroups = groupRows(rows, (row) => row.recordingIdentityId).filter(
    (group) => distinct(group.map(trackRefKey)).length > 1,
  );
  for (const group of exactAliasGroups) {
    addGroupPairs(pairMap, group, "canonical");
  }

  const isrcGroups = groupRows(rows, (row) => normalizeIsrcEvidence(row.isrc)).filter(
    (group) => distinct(group.map((row) => row.recordingIdentityId)).length > 1,
  );
  for (const group of isrcGroups) addGroupPairs(pairMap, group, "isrc");

  const mbidGroups = groupRows(rows, (row) => clean(row.trackMbid)?.toLowerCase() ?? null).filter(
    (group) => distinct(group.map((row) => row.recordingIdentityId)).length > 1,
  );
  for (const group of mbidGroups) addGroupPairs(pairMap, group, "mbid");

  const sameArtistTitleGroups = groupRows(rows, (row) => {
    const artistId = clean(row.primaryArtistProviderId);
    const baseTitle = deriveBaseTitleSignal(row.trackName);
    return artistId && baseTitle ? `${artistId}\u0000${baseTitle}` : null;
  }).filter((group) => distinct(group.map((row) => row.recordingIdentityId)).length > 1);
  for (const group of sameArtistTitleGroups) addGroupPairs(pairMap, group, "textual");

  const pairs = [...pairMap.values()]
    .map(resolvePair)
    .sort(compareResolvedPairs);

  const crossArtistCollisions = buildCrossArtistCollisionGroups(rows);
  const albumEditionGroups = buildAlbumEditionGroups(rows);
  const spotifyGlobalRefs = rows.filter(
    (row) => row.provider === SPOTIFY_PROVIDER && row.providerScope === GLOBAL_PROVIDER_SCOPE,
  );
  const cacheEnriched = spotifyGlobalRefs.filter(
    (row) => row.sourcePlaylistIds.length > 0,
  ).length;

  const fullValidSources = context.fullValidSources ?? 0;
  const partialValidSources = context.partialValidSources ?? 0;
  const missingSources = context.missingSources ?? 0;
  const invalidSources = context.invalidSources ?? 0;
  const completeSnapshot =
    partialValidSources === 0 && missingSources === 0 && invalidSources === 0;

  return {
    gate: "3",
    mode: "SHADOW_READ_ONLY",
    userId: context.userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: false,
      writes: false,
      basis: "PERSISTED_CANONICAL_GRAPH_PLUS_SOURCE_CACHE",
      liveProviderSnapshotVerified: false,
      interpretation: completeSnapshot
        ? "COMPLETE_PERSISTED_SNAPSHOT"
        : "LOWER_BOUND_PERSISTED_SNAPSHOT",
    },
    safety: {
      plannerInfluence: false,
      identityMutation: false,
      consumerActivation: false,
      cacheMutation: false,
    },
    scope: {
      enabledTargets: context.enabledTargets ?? 0,
      configuredMusicSources: context.configuredMusicSources ?? 0,
      enabledMusicSources: context.enabledMusicSources ?? 0,
      reachableMusicSources: context.reachableMusicSources ?? 0,
      unreachableEnabledMusicSources: context.unreachableEnabledMusicSources ?? 0,
    },
    cache: {
      fullValidSources,
      partialValidSources,
      missingSources,
      invalidSources,
      distinctSpotifyTracks: context.distinctSpotifyTracks ?? 0,
    },
    canonical: {
      trackProviderRefs: rows.length,
      spotifyGlobalTrackProviderRefs: spotifyGlobalRefs.length,
      cacheEnrichedTrackProviderRefs: cacheEnriched,
      canonicalOutsidePersistedCache: spotifyGlobalRefs.length - cacheEnriched,
    },
    evidence: {
      exactAliasGroups: exactAliasGroups.length,
      sameIsrcGroups: isrcGroups.length,
      sameTrackMbidGroups: mbidGroups.length,
      crossArtistTitleCollisionGroups: crossArtistCollisions.length,
      albumEditionGroups: albumEditionGroups.length,
    },
    resolution: {
      pairCount: pairs.length,
      exactProviderAliasPairs: countReason(pairs, "EXACT_PROVIDER_ALIAS"),
      sameRecordingHighConfidencePairs: pairs.filter(
        (pair) =>
          pair.resolution.level === "RECORDING" &&
          pair.resolution.action === "REVIEW_RECORDING_MERGE",
      ).length,
      sameSongDifferentRecordingPairs: countReason(
        pairs,
        "SAME_SONG_DIFFERENT_RECORDING",
      ),
      textualPossibleMatchPairs: countReason(pairs, "TEXTUAL_POSSIBLE_MATCH"),
      ambiguousPairs: pairs.filter(
        (pair) => pair.resolution.status === "AMBIGUOUS",
      ).length,
      liveVsStudioPairs: pairs.filter((pair) => traitTransition(pair, "LIVE", "STANDARD")).length,
      remasterPairs: pairs.filter((pair) => pairHasTrait(pair, "REMASTER")).length,
      acousticPairs: pairs.filter((pair) => pairHasTrait(pair, "ACOUSTIC")).length,
      remixPairs: pairs.filter((pair) => pairHasTrait(pair, "REMIX")).length,
      demoPairs: pairs.filter((pair) => pairHasTrait(pair, "DEMO")).length,
      confidence: {
        high: pairs.filter((pair) => pair.resolution.confidenceBasisPoints >= 9000).length,
        medium: pairs.filter(
          (pair) =>
            pair.resolution.confidenceBasisPoints >= 7000 &&
            pair.resolution.confidenceBasisPoints < 9000,
        ).length,
        low: pairs.filter((pair) => pair.resolution.confidenceBasisPoints < 7000).length,
      },
      pairs: pairs.slice(0, SAMPLE_LIMIT),
    },
    guards: {
      crossArtistTitleCollisions: crossArtistCollisions.slice(0, SAMPLE_LIMIT),
      albumEditionCandidates: albumEditionGroups.slice(0, SAMPLE_LIMIT),
    },
  };
}

export async function runMusicIdentityShadowResolverReport(
  userIdInput: string,
): Promise<MusicIdentityShadowResolverReport> {
  const userId = clean(userIdInput);
  if (!userId) throw new Error("userId is required");

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new Error(`Sonoriza user not found: ${userId}`);

      const [sources, targets, refs] = await Promise.all([
        tx.sourcePlaylist.findMany({
          where: { userId },
          select: {
            id: true,
            kind: true,
            enabled: true,
            cachedCandidates: true,
            cacheUpdatedAt: true,
          },
        }),
        tx.targetPlaylist.findMany({
          where: { userId, enabled: true },
          select: {
            id: true,
            name: true,
            sourceScopeMode: true,
            sourceSelections: { select: { sourcePlaylistId: true } },
          },
        }),
        tx.trackProviderRef.findMany({
          where: { userId },
          select: {
            provider: true,
            providerScope: true,
            providerTrackId: true,
            recordingIdentityId: true,
            isrc: true,
            trackMbid: true,
            recording: {
              select: {
                songIdentityId: true,
                song: {
                  select: {
                    canonicalTitle: true,
                    primaryArtistIdentityId: true,
                    primaryArtist: {
                      select: {
                        canonicalName: true,
                        providerRefs: {
                          where: {
                            provider: SPOTIFY_PROVIDER,
                            providerScope: GLOBAL_PROVIDER_SCOPE,
                          },
                          orderBy: { providerArtistId: "asc" },
                          take: 1,
                          select: { providerArtistId: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ]);

      const configuredMusicSources = sources.filter((source) => source.kind === "MUSIC");
      const enabledMusicSources = configuredMusicSources.filter((source) => source.enabled);
      const scopeSources = sources.map((source) => ({ id: source.id, enabled: source.enabled }));
      const reachableSourceIds = new Set<string>();
      for (const target of targets) {
        const scope = resolveTargetSourceScope({
          targetPlaylistId: target.id,
          targetName: target.name,
          sourceScopeMode: target.sourceScopeMode,
          selectedSourceIds: target.sourceSelections.map((row) => row.sourcePlaylistId),
          sources: scopeSources,
        });
        for (const sourceId of scope.effectiveSourceIds) reachableSourceIds.add(sourceId);
      }

      const reachableMusicSources = configuredMusicSources.filter((source) =>
        reachableSourceIds.has(source.id),
      );
      const cache = collectCacheEvidence(reachableMusicSources);
      const rows: ShadowResolverTrackRow[] = refs.map((ref) => {
        const cacheEvidence =
          ref.provider === SPOTIFY_PROVIDER && ref.providerScope === GLOBAL_PROVIDER_SCOPE
            ? cache.byTrackId.get(ref.providerTrackId)
            : undefined;
        return {
          provider: ref.provider,
          providerScope: ref.providerScope,
          providerTrackId: ref.providerTrackId,
          recordingIdentityId: ref.recordingIdentityId,
          songIdentityId: ref.recording.songIdentityId,
          primaryArtistIdentityId: ref.recording.song.primaryArtistIdentityId,
          primaryArtistProviderId:
            ref.recording.song.primaryArtist.providerRefs[0]?.providerArtistId ?? null,
          primaryArtistName:
            cacheEvidence?.primaryArtistName ??
            ref.recording.song.primaryArtist.canonicalName,
          trackName: cacheEvidence?.trackName ?? ref.recording.song.canonicalTitle,
          albumProviderId: cacheEvidence?.albumProviderId ?? null,
          albumName: cacheEvidence?.albumName ?? null,
          durationMs: cacheEvidence?.durationMs ?? null,
          isrc: ref.isrc,
          trackMbid: ref.trackMbid,
          sourcePlaylistIds: cacheEvidence?.sourcePlaylistIds ?? [],
        };
      });

      return buildMusicIdentityShadowResolverReport(rows, {
        userId,
        enabledTargets: targets.length,
        configuredMusicSources: configuredMusicSources.length,
        enabledMusicSources: enabledMusicSources.length,
        reachableMusicSources: reachableMusicSources.length,
        unreachableEnabledMusicSources: enabledMusicSources.filter(
          (source) => !reachableSourceIds.has(source.id),
        ).length,
        fullValidSources: cache.fullValidSources,
        partialValidSources: cache.partialValidSources,
        missingSources: cache.missingSources,
        invalidSources: cache.invalidSources,
        distinctSpotifyTracks: cache.byTrackId.size,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function collectCacheEvidence(
  sources: Array<{
    id: string;
    cachedCandidates: Prisma.JsonValue | null;
    cacheUpdatedAt: Date | null;
  }>,
) {
  const observations = new Map<
    string,
    Array<{
      sourcePlaylistId: string;
      observedAt: Date | null;
      trackName: string;
      primaryArtistName: string | null;
      albumProviderId: string | null;
      albumName: string | null;
      durationMs: number;
    }>
  >();
  let fullValidSources = 0;
  let partialValidSources = 0;
  let missingSources = 0;
  let invalidSources = 0;

  for (const source of sources) {
    const full = decodeMusicSourceCache(source.cachedCandidates);
    const partial = full === null ? decodePartialMusicSourceCache(source.cachedCandidates) : null;
    const status: CacheStatus = full
      ? "FULL_VALID"
      : partial
        ? "PARTIAL_VALID"
        : source.cachedCandidates == null
          ? "MISSING"
          : "INVALID";

    if (status === "FULL_VALID") fullValidSources += 1;
    if (status === "PARTIAL_VALID") partialValidSources += 1;
    if (status === "MISSING") missingSources += 1;
    if (status === "INVALID") invalidSources += 1;

    const candidates = full ?? partial?.candidates ?? [];
    for (const candidate of candidates) {
      if (!candidate.spotifyTrackId) continue;
      const bucket = observations.get(candidate.spotifyTrackId) ?? [];
      bucket.push({
        sourcePlaylistId: source.id,
        observedAt: source.cacheUpdatedAt,
        trackName: candidate.title,
        primaryArtistName: candidate.primaryArtistName ?? null,
        albumProviderId: candidate.albumId ?? null,
        albumName: candidate.albumName ?? null,
        durationMs: candidate.durationMs,
      });
      observations.set(candidate.spotifyTrackId, bucket);
    }
  }

  const byTrackId = new Map<
    string,
    {
      trackName: string;
      primaryArtistName: string | null;
      albumProviderId: string | null;
      albumName: string | null;
      durationMs: number;
      sourcePlaylistIds: string[];
    }
  >();
  for (const [trackId, trackObservations] of observations) {
    const sorted = [...trackObservations].sort((a, b) => {
      const time = (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0);
      return time || a.sourcePlaylistId.localeCompare(b.sourcePlaylistId);
    });
    const chosen = sorted[0]!;
    byTrackId.set(trackId, {
      trackName: chosen.trackName,
      primaryArtistName: chosen.primaryArtistName,
      albumProviderId: chosen.albumProviderId,
      albumName: chosen.albumName,
      durationMs: chosen.durationMs,
      sourcePlaylistIds: distinct(sorted.map((row) => row.sourcePlaylistId)).sort(),
    });
  }

  return {
    byTrackId,
    fullValidSources,
    partialValidSources,
    missingSources,
    invalidSources,
  };
}

function addGroupPairs(
  pairMap: Map<string, PairAccumulator>,
  group: ShadowResolverTrackRow[],
  evidence: "canonical" | "isrc" | "mbid" | "textual",
) {
  for (let i = 0; i < group.length; i += 1) {
    for (let j = i + 1; j < group.length; j += 1) {
      const first = group[i]!;
      const second = group[j]!;
      if (trackRefKey(first) === trackRefKey(second)) continue;
      const [left, right] = compareRows(first, second) <= 0 ? [first, second] : [second, first];
      const key = `${trackRefKey(left)}\u0000${trackRefKey(right)}`;
      const current = pairMap.get(key) ?? {
        left,
        right,
        sameCanonicalRecording: false,
        sameIsrc: false,
        sameTrackMbid: false,
        sameTextualSignal: false,
      };
      if (evidence === "canonical") current.sameCanonicalRecording = true;
      if (evidence === "isrc") current.sameIsrc = true;
      if (evidence === "mbid") current.sameTrackMbid = true;
      if (evidence === "textual") current.sameTextualSignal = true;
      pairMap.set(key, current);
    }
  }
}

function resolvePair(pair: PairAccumulator): ShadowResolverPair {
  const leftTrait = classifyShadowResolverVersion(pair.left);
  const rightTrait = classifyShadowResolverVersion(pair.right);
  const sameArtist = Boolean(
    pair.left.primaryArtistProviderId &&
      pair.left.primaryArtistProviderId === pair.right.primaryArtistProviderId,
  );
  const leftBase = deriveBaseTitleSignal(pair.left.trackName);
  const rightBase = deriveBaseTitleSignal(pair.right.trackName);
  const sameBaseTitle = Boolean(leftBase && leftBase === rightBase);
  const durationDeltaMs =
    pair.left.durationMs != null && pair.right.durationMs != null
      ? Math.abs(pair.left.durationMs - pair.right.durationMs)
      : null;

  const base = {
    left: summarize(pair.left),
    right: summarize(pair.right),
    evidence: {
      sameCanonicalRecording: pair.sameCanonicalRecording,
      sameIsrc: pair.sameIsrc,
      sameTrackMbid: pair.sameTrackMbid,
      samePrimaryArtistProviderId: sameArtist,
      sameBaseTitleSignal: sameBaseTitle,
      durationDeltaMs,
      leftVersionTrait: leftTrait,
      rightVersionTrait: rightTrait,
    },
  };

  if (pair.sameCanonicalRecording) {
    return {
      ...base,
      resolution: {
        status: "MATCH",
        reason: "EXACT_PROVIDER_ALIAS",
        level: "RECORDING",
        action: "ALREADY_LINKED",
        confidenceBasisPoints: 10_000,
      },
    };
  }

  if (pair.sameTrackMbid || pair.sameIsrc) {
    const strongConflict =
      !sameArtist ||
      !sameBaseTitle ||
      versionsConflictForRecording(leftTrait, rightTrait) ||
      durationStronglyConflicts(pair.left.durationMs, pair.right.durationMs);

    if (strongConflict) {
      return {
        ...base,
        resolution: {
          status: "AMBIGUOUS",
          reason: "AMBIGUOUS",
          level: "NONE",
          action: "REVIEW_ONLY",
          confidenceBasisPoints: 4_000,
        },
      };
    }

    return {
      ...base,
      resolution: {
        status: "MATCH",
        reason: pair.sameTrackMbid ? "SAME_RECORDING_HIGH_CONFIDENCE" : "SAME_ISRC",
        level: "RECORDING",
        action: "REVIEW_RECORDING_MERGE",
        confidenceBasisPoints: pair.sameTrackMbid ? 9_900 : 9_700,
      },
    };
  }

  if (pair.sameTextualSignal && sameArtist && sameBaseTitle) {
    if (clearlyDifferentRecording(leftTrait, rightTrait)) {
      return {
        ...base,
        resolution: {
          status: "MATCH",
          reason: "SAME_SONG_DIFFERENT_RECORDING",
          level: "SONG_ONLY",
          action: "KEEP_RECORDINGS_SEPARATE",
          confidenceBasisPoints: 9_000,
        },
      };
    }

    return {
      ...base,
      resolution: {
        status: "AMBIGUOUS",
        reason: "TEXTUAL_POSSIBLE_MATCH",
        level: "NONE",
        action: "REVIEW_ONLY",
        confidenceBasisPoints:
          leftTrait === "REMASTER" || rightTrait === "REMASTER" ? 7_500 : 6_500,
      },
    };
  }

  return {
    ...base,
    resolution: {
      status: "AMBIGUOUS",
      reason: "AMBIGUOUS",
      level: "NONE",
      action: "REVIEW_ONLY",
      confidenceBasisPoints: 2_500,
    },
  };
}

function buildCrossArtistCollisionGroups(
  rows: ShadowResolverTrackRow[],
): CrossArtistCollisionGroup[] {
  return groupRows(rows, (row) => deriveBaseTitleSignal(row.trackName))
    .map((group) => {
      const withArtist = group.filter(
        (row): row is ShadowResolverTrackRow & { primaryArtistProviderId: string } =>
          Boolean(row.primaryArtistProviderId),
      );
      const artistIds = distinct(withArtist.map((row) => row.primaryArtistProviderId));
      if (artistIds.length < 2) return null;
      return {
        baseTitleSignal: deriveBaseTitleSignal(withArtist[0]?.trackName)!,
        distinctArtistProviderIds: artistIds.length,
        trackCount: withArtist.length,
        sampleTracks: withArtist.slice(0, 5).map((row) => ({
          providerTrackId: row.providerTrackId,
          primaryArtistProviderId: row.primaryArtistProviderId,
          primaryArtistName: row.primaryArtistName,
          trackName: row.trackName,
        })),
      };
    })
    .filter((group): group is CrossArtistCollisionGroup => Boolean(group))
    .sort(
      (a, b) =>
        b.distinctArtistProviderIds - a.distinctArtistProviderIds ||
        b.trackCount - a.trackCount ||
        a.baseTitleSignal.localeCompare(b.baseTitleSignal),
    );
}

function buildAlbumEditionGroups(rows: ShadowResolverTrackRow[]): AlbumEditionGroup[] {
  const uniqueAlbums = new Map<
    string,
    {
      primaryArtistProviderId: string;
      primaryArtistName: string;
      albumProviderId: string;
      albumName: string;
    }
  >();
  for (const row of rows) {
    if (!row.primaryArtistProviderId || !row.albumProviderId || !clean(row.albumName)) continue;
    uniqueAlbums.set(`${row.primaryArtistProviderId}\u0000${row.albumProviderId}`, {
      primaryArtistProviderId: row.primaryArtistProviderId,
      primaryArtistName: row.primaryArtistName,
      albumProviderId: row.albumProviderId,
      albumName: row.albumName!,
    });
  }

  const groups = new Map<string, Array<(typeof uniqueAlbums extends Map<string, infer V> ? V : never)>>();
  for (const album of uniqueAlbums.values()) {
    const base = deriveBaseAlbumTitleSignal(album.albumName);
    if (!base) continue;
    const key = `${album.primaryArtistProviderId}\u0000${base}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(album);
    groups.set(key, bucket);
  }

  return [...groups.values()]
    .filter((group) => distinct(group.map((album) => album.albumProviderId)).length > 1)
    .map((group) => ({
      primaryArtistProviderId: group[0]!.primaryArtistProviderId,
      primaryArtistName: group[0]!.primaryArtistName,
      baseAlbumTitleSignal: deriveBaseAlbumTitleSignal(group[0]!.albumName)!,
      albumCount: group.length,
      albums: group
        .map((album) => ({
          albumProviderId: album.albumProviderId,
          albumName: album.albumName,
          editionTrait: albumEditionTrait(album.albumName),
        }))
        .sort((a, b) => a.albumProviderId.localeCompare(b.albumProviderId)),
    }))
    .sort(
      (a, b) =>
        b.albumCount - a.albumCount ||
        a.baseAlbumTitleSignal.localeCompare(b.baseAlbumTitleSignal),
    );
}

function albumEditionTrait(value: string): string {
  if (/\bdeluxe\b/i.test(value)) return "DELUXE";
  if (/\bexpanded\b/i.test(value)) return "EXPANDED";
  if (/\banniversary\b/i.test(value)) return "ANNIVERSARY";
  if (/\bspecial\s+edition\b/i.test(value)) return "SPECIAL_EDITION";
  if (/\bremaster(?:ed)?\b/i.test(value)) return "REMASTER";
  return "STANDARD_OR_OTHER_RELEASE";
}

function hasVersionQualifier(value: string, trait: RegExp): boolean {
  if (!value) return false;
  const suffix = /(?:\s[-–—:]\s*|\s[\[(])([^\])]{1,90})(?:[\])])?\s*$/i.exec(value);
  return Boolean(suffix?.[1] && trait.test(suffix[1]));
}

function hasEditionQualifier(value: string, trait: RegExp): boolean {
  if (!value) return false;
  return ALBUM_EDITION_STRIPPERS.some((pattern) => pattern.test(value)) && trait.test(value);
}

function clearlyDifferentRecording(
  left: ShadowResolverVersionTrait,
  right: ShadowResolverVersionTrait,
): boolean {
  if (left === right) return false;
  const concrete = new Set<ShadowResolverVersionTrait>(["LIVE", "ACOUSTIC", "REMIX", "DEMO"]);
  return concrete.has(left) || concrete.has(right);
}

function versionsConflictForRecording(
  left: ShadowResolverVersionTrait,
  right: ShadowResolverVersionTrait,
): boolean {
  if (left === right || left === "UNKNOWN" || right === "UNKNOWN") return false;
  if (
    (left === "STANDARD" && right === "REMASTER") ||
    (left === "REMASTER" && right === "STANDARD")
  ) {
    return false;
  }
  return clearlyDifferentRecording(left, right);
}

function durationStronglyConflicts(left: number | null, right: number | null): boolean {
  if (left == null || right == null || left <= 0 || right <= 0) return false;
  const delta = Math.abs(left - right);
  return delta > Math.max(10_000, Math.min(left, right) * 0.05);
}

function summarize(row: ShadowResolverTrackRow): ShadowResolverTrackSummary {
  return {
    provider: row.provider,
    providerScope: row.providerScope,
    providerTrackId: row.providerTrackId,
    recordingIdentityId: row.recordingIdentityId,
    primaryArtistProviderId: row.primaryArtistProviderId,
    primaryArtistName: row.primaryArtistName,
    trackName: row.trackName,
    albumProviderId: row.albumProviderId,
    albumName: row.albumName,
    durationMs: row.durationMs,
  };
}

function groupRows(
  rows: ShadowResolverTrackRow[],
  keyFn: (row: ShadowResolverTrackRow) => string | null,
): ShadowResolverTrackRow[][] {
  const groups = new Map<string, ShadowResolverTrackRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function countReason(pairs: ShadowResolverPair[], reason: IdentityMatchReason): number {
  return pairs.filter((pair) => pair.resolution.reason === reason).length;
}

function pairHasTrait(pair: ShadowResolverPair, trait: ShadowResolverVersionTrait): boolean {
  return (
    pair.evidence.leftVersionTrait === trait || pair.evidence.rightVersionTrait === trait
  );
}

function traitTransition(
  pair: ShadowResolverPair,
  first: ShadowResolverVersionTrait,
  second: ShadowResolverVersionTrait,
): boolean {
  return (
    (pair.evidence.leftVersionTrait === first && pair.evidence.rightVersionTrait === second) ||
    (pair.evidence.leftVersionTrait === second && pair.evidence.rightVersionTrait === first)
  );
}

function compareResolvedPairs(a: ShadowResolverPair, b: ShadowResolverPair): number {
  return (
    b.resolution.confidenceBasisPoints - a.resolution.confidenceBasisPoints ||
    a.left.providerTrackId.localeCompare(b.left.providerTrackId) ||
    a.right.providerTrackId.localeCompare(b.right.providerTrackId)
  );
}

function compareRows(a: ShadowResolverTrackRow, b: ShadowResolverTrackRow): number {
  return trackRefKey(a).localeCompare(trackRefKey(b));
}

function trackRefKey(row: ShadowResolverTrackRow): string {
  return `${row.provider}\u0000${row.providerScope}\u0000${row.providerTrackId}`;
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ");
}

function comparisonText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[’‘]/g, "'").trim();
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function classifyLegacyLiveSignal(input: {
  trackName: string | null | undefined;
  albumName?: string | null | undefined;
}): TrackVersionClassification {
  return classifyTrackVersion(input).classification;
}
