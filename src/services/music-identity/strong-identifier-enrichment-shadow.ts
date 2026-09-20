import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
  runMusicIdentityShadowResolverReport,
  type ShadowResolverVersionTrait,
} from "@/services/music-identity/shadow-resolver-report";
import { normalizeIsrcEvidence } from "@/services/music-identity/contracts";
import {
  SpotifyCatalogSearchClient,
  type SpotifyCatalogTrackLookup,
} from "@/services/spotify/catalog-search";
import {
  decodeMusicSourceCache,
  decodePartialMusicSourceCache,
} from "@/services/spotify/source-cache";
import { resolveTargetSourceScope } from "@/services/target-source-scope";

const SPOTIFY_PROVIDER = "spotify";
const GLOBAL_PROVIDER_SCOPE = "global";
const MAX_TEXTUAL_PAIRS = 500;
const MAX_PROVIDER_TRACKS = 500;
const SAMPLE_LIMIT = 25;

type ProviderLookup = {
  lookupTracksByIds(
    trackIds: readonly string[],
  ): Promise<SpotifyCatalogTrackLookup[]>;
  getMetrics?: () => unknown;
};

type TextualPairTrack = {
  providerTrackId: string;
  recordingIdentityId: string;
  primaryArtistId: string;
  primaryArtistName: string;
  trackName: string;
  albumName: string | null;
  durationMs: number;
  versionTrait: ShadowResolverVersionTrait;
};

type TextualPair = {
  left: TextualPairTrack;
  right: TextualPairTrack;
};

export type StrongIdentifierPairResult = {
  left: TextualPairTrack & {
    isrc: string | null;
    resolvedTrackId: string | null;
    linkedFromTrackId: string | null;
  };
  right: TextualPairTrack & {
    isrc: string | null;
    resolvedTrackId: string | null;
    linkedFromTrackId: string | null;
  };
  baselineKind:
    | "SAME_SONG_DIFFERENT_RECORDING"
    | "TEXTUAL_POSSIBLE_MATCH";
  outcome:
    | "REVIEW_RECORDING_MERGE"
    | "KEEP_RECORDINGS_SEPARATE"
    | "DIFFERENT_ISRC_REVIEW_ONLY"
    | "STRONG_ID_CONFLICT_REVIEW_ONLY"
    | "INSUFFICIENT_STRONG_ID";
  sameIsrc: boolean;
  durationDeltaMs: number;
};

export type MusicIdentityStrongIdentifierShadowReport = {
  gate: "3B";
  mode: "SHADOW_PROVIDER_ENRICHMENT_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: true;
    provider: "spotify";
    endpoint: "GET /tracks/{id}";
    endpointDeprecated: false;
    identityWrites: false;
    canonicalWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
    basis: "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC";
  };
  baseline: {
    interpretation:
      | "COMPLETE_PERSISTED_SNAPSHOT"
      | "LOWER_BOUND_PERSISTED_SNAPSHOT";
    pairCount: number;
    textualPossibleMatchPairs: number;
    sameSongDifferentRecordingPairs: number;
    exactProviderAliasPairs: number;
    sameRecordingHighConfidencePairs: number;
    reconstructedTextualPairs: number;
  };
  provider: {
    requestedDistinctTracks: number;
    returnedTracks: number;
    tracksWithIsrc: number;
    tracksMissingIsrc: number;
    relinkedTracks: number;
    nullTracks: number;
    metrics: unknown;
  };
  resolution: {
    pairCount: number;
    sameIsrcPairs: number;
    differentIsrcPairs: number;
    missingIsrcPairs: number;
    upgradedToRecordingReviewPairs: number;
    keptSeparatePairs: number;
    strongIdConflictPairs: number;
    reviewOnlyDifferentIsrcPairs: number;
    insufficientStrongIdPairs: number;
    samples: StrongIdentifierPairResult[];
  };
};

export type StrongIdentifierShadowAbstentionReport = {
  gate: "3B";
  mode: "SHADOW_PROVIDER_ENRICHMENT_ABSTAINED";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: false;
    identityWrites: false;
    canonicalWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
  };
  abstentionReason:
    | "INCOMPLETE_PERSISTED_SNAPSHOT"
    | "BASELINE_ALREADY_HAS_STRONG_RECORDING_EVIDENCE"
    | "PAIR_SET_MISMATCH"
    | "PAIR_LIMIT_EXCEEDED"
    | "TRACK_LIMIT_EXCEEDED";
  baseline: {
    pairCount: number;
    textualPossibleMatchPairs: number;
    sameSongDifferentRecordingPairs: number;
    reconstructedTextualPairs: number;
  };
};

export async function runMusicIdentityStrongIdentifierShadow(
  userIdInput: string,
  options: { provider?: ProviderLookup } = {},
): Promise<
  MusicIdentityStrongIdentifierShadowReport | StrongIdentifierShadowAbstentionReport
> {
  const userId = clean(userIdInput);
  if (!userId) throw new Error("userId is required");

  const baseline = await runMusicIdentityShadowResolverReport(userId);
  const baselineSummary = {
    pairCount: baseline.resolution.pairCount,
    textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
    sameSongDifferentRecordingPairs:
      baseline.resolution.sameSongDifferentRecordingPairs,
    reconstructedTextualPairs: 0,
  };

  if (baseline.authority.interpretation !== "COMPLETE_PERSISTED_SNAPSHOT") {
    return abstain(
      userId,
      "INCOMPLETE_PERSISTED_SNAPSHOT",
      baselineSummary,
    );
  }

  if (
    baseline.resolution.exactProviderAliasPairs > 0 ||
    baseline.resolution.sameRecordingHighConfidencePairs > 0 ||
    baseline.evidence.sameIsrcGroups > 0 ||
    baseline.evidence.sameTrackMbidGroups > 0
  ) {
    return abstain(
      userId,
      "BASELINE_ALREADY_HAS_STRONG_RECORDING_EVIDENCE",
      baselineSummary,
    );
  }

  const textualPairs = await collectTextualCandidatePairs(userId);
  baselineSummary.reconstructedTextualPairs = textualPairs.length;
  const expectedTextualPairs =
    baseline.resolution.textualPossibleMatchPairs +
    baseline.resolution.sameSongDifferentRecordingPairs;

  if (textualPairs.length !== expectedTextualPairs) {
    return abstain(userId, "PAIR_SET_MISMATCH", baselineSummary);
  }

  if (textualPairs.length > MAX_TEXTUAL_PAIRS) {
    return abstain(userId, "PAIR_LIMIT_EXCEEDED", baselineSummary);
  }

  const trackIds = distinct(
    textualPairs.flatMap((pair) => [
      pair.left.providerTrackId,
      pair.right.providerTrackId,
    ]),
  ).sort();

  if (trackIds.length > MAX_PROVIDER_TRACKS) {
    return abstain(userId, "TRACK_LIMIT_EXCEEDED", baselineSummary);
  }

  const provider =
    options.provider ?? (await SpotifyCatalogSearchClient.forUser(userId));
  const lookups = await provider.lookupTracksByIds(trackIds);
  const lookupByRequestedId = new Map(
    lookups.map((lookup) => [lookup.requestedTrackId, lookup]),
  );

  const pairResults = textualPairs.map((pair) =>
    evaluatePair(
      pair,
      lookupByRequestedId.get(pair.left.providerTrackId) ?? null,
      lookupByRequestedId.get(pair.right.providerTrackId) ?? null,
    ),
  );

  const returnedTracks = lookups.filter((lookup) => lookup.track !== null);
  const tracksWithIsrc = returnedTracks.filter(
    (lookup) => normalizeIsrcEvidence(lookup.track?.isrc) !== null,
  ).length;
  const relinkedTracks = returnedTracks.filter(
    (lookup) =>
      Boolean(lookup.track?.linkedFromTrackId) ||
      (lookup.track?.id &&
        lookup.track.id !== lookup.requestedTrackId),
  ).length;

  return {
    gate: "3B",
    mode: "SHADOW_PROVIDER_ENRICHMENT_READ_ONLY",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: true,
      provider: "spotify",
      endpoint: "GET /tracks/{id}",
      endpointDeprecated: false,
      identityWrites: false,
      canonicalWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
      basis: "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC",
    },
    baseline: {
      interpretation: baseline.authority.interpretation,
      pairCount: baseline.resolution.pairCount,
      textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
      sameSongDifferentRecordingPairs:
        baseline.resolution.sameSongDifferentRecordingPairs,
      exactProviderAliasPairs: baseline.resolution.exactProviderAliasPairs,
      sameRecordingHighConfidencePairs:
        baseline.resolution.sameRecordingHighConfidencePairs,
      reconstructedTextualPairs: textualPairs.length,
    },
    provider: {
      requestedDistinctTracks: trackIds.length,
      returnedTracks: returnedTracks.length,
      tracksWithIsrc,
      tracksMissingIsrc: returnedTracks.length - tracksWithIsrc,
      relinkedTracks,
      nullTracks: lookups.length - returnedTracks.length,
      metrics: provider.getMetrics?.() ?? null,
    },
    resolution: {
      pairCount: pairResults.length,
      sameIsrcPairs: countOutcome(pairResults, (row) => row.sameIsrc),
      differentIsrcPairs: countOutcome(
        pairResults,
        (row) =>
          Boolean(row.left.isrc) &&
          Boolean(row.right.isrc) &&
          row.left.isrc !== row.right.isrc,
      ),
      missingIsrcPairs: countOutcome(
        pairResults,
        (row) => !row.left.isrc || !row.right.isrc,
      ),
      upgradedToRecordingReviewPairs: countOutcome(
        pairResults,
        (row) => row.outcome === "REVIEW_RECORDING_MERGE",
      ),
      keptSeparatePairs: countOutcome(
        pairResults,
        (row) => row.outcome === "KEEP_RECORDINGS_SEPARATE",
      ),
      strongIdConflictPairs: countOutcome(
        pairResults,
        (row) => row.outcome === "STRONG_ID_CONFLICT_REVIEW_ONLY",
      ),
      reviewOnlyDifferentIsrcPairs: countOutcome(
        pairResults,
        (row) => row.outcome === "DIFFERENT_ISRC_REVIEW_ONLY",
      ),
      insufficientStrongIdPairs: countOutcome(
        pairResults,
        (row) => row.outcome === "INSUFFICIENT_STRONG_ID",
      ),
      samples: pairResults.slice(0, SAMPLE_LIMIT),
    },
  };
}

export function evaluatePair(
  pair: TextualPair,
  leftLookup: SpotifyCatalogTrackLookup | null,
  rightLookup: SpotifyCatalogTrackLookup | null,
): StrongIdentifierPairResult {
  const leftIsrc = normalizeIsrcEvidence(leftLookup?.track?.isrc) ?? null;
  const rightIsrc = normalizeIsrcEvidence(rightLookup?.track?.isrc) ?? null;
  const sameIsrc = Boolean(leftIsrc && rightIsrc && leftIsrc === rightIsrc);
  const durationDeltaMs = Math.abs(
    pair.left.durationMs - pair.right.durationMs,
  );
  const baselineKind = clearlyDifferentRecording(
    pair.left.versionTrait,
    pair.right.versionTrait,
  )
    ? "SAME_SONG_DIFFERENT_RECORDING"
    : "TEXTUAL_POSSIBLE_MATCH";

  let outcome: StrongIdentifierPairResult["outcome"];
  if (!leftIsrc || !rightIsrc) {
    outcome =
      baselineKind === "SAME_SONG_DIFFERENT_RECORDING"
        ? "KEEP_RECORDINGS_SEPARATE"
        : "INSUFFICIENT_STRONG_ID";
  } else if (leftIsrc !== rightIsrc) {
    outcome =
      baselineKind === "SAME_SONG_DIFFERENT_RECORDING"
        ? "KEEP_RECORDINGS_SEPARATE"
        : "DIFFERENT_ISRC_REVIEW_ONLY";
  } else if (
    recordingVersionConflict(
      pair.left.versionTrait,
      pair.right.versionTrait,
    ) ||
    durationStronglyConflicts(pair.left.durationMs, pair.right.durationMs)
  ) {
    outcome = "STRONG_ID_CONFLICT_REVIEW_ONLY";
  } else if (baselineKind === "SAME_SONG_DIFFERENT_RECORDING") {
    outcome = "STRONG_ID_CONFLICT_REVIEW_ONLY";
  } else {
    outcome = "REVIEW_RECORDING_MERGE";
  }

  return {
    left: {
      ...pair.left,
      isrc: leftIsrc,
      resolvedTrackId: leftLookup?.track?.id ?? null,
      linkedFromTrackId: leftLookup?.track?.linkedFromTrackId ?? null,
    },
    right: {
      ...pair.right,
      isrc: rightIsrc,
      resolvedTrackId: rightLookup?.track?.id ?? null,
      linkedFromTrackId: rightLookup?.track?.linkedFromTrackId ?? null,
    },
    baselineKind,
    outcome,
    sameIsrc,
    durationDeltaMs,
  };
}

async function collectTextualCandidatePairs(
  userId: string,
): Promise<TextualPair[]> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

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
          where: {
            userId,
            provider: SPOTIFY_PROVIDER,
            providerScope: GLOBAL_PROVIDER_SCOPE,
          },
          select: {
            providerTrackId: true,
            recordingIdentityId: true,
            recording: {
              select: {
                song: {
                  select: {
                    canonicalTitle: true,
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

      const scopeSources = sources.map((source) => ({
        id: source.id,
        enabled: source.enabled,
      }));
      const reachableSourceIds = new Set<string>();
      for (const target of targets) {
        const scope = resolveTargetSourceScope({
          targetPlaylistId: target.id,
          targetName: target.name,
          sourceScopeMode: target.sourceScopeMode,
          selectedSourceIds: target.sourceSelections.map(
            (row) => row.sourcePlaylistId,
          ),
          sources: scopeSources,
        });
        for (const sourceId of scope.effectiveSourceIds) {
          reachableSourceIds.add(sourceId);
        }
      }

      const refByTrackId = new Map(
        refs.map((ref) => [ref.providerTrackId, ref]),
      );
      const observations = new Map<
        string,
        Array<{
          sourcePlaylistId: string;
          observedAt: Date | null;
          primaryArtistId: string;
          primaryArtistName: string;
          trackName: string;
          albumName: string | null;
          durationMs: number;
        }>
      >();

      for (const source of sources) {
        if (
          source.kind !== "MUSIC" ||
          !reachableSourceIds.has(source.id)
        ) {
          continue;
        }

        const full = decodeMusicSourceCache(source.cachedCandidates);
        const partial =
          full === null
            ? decodePartialMusicSourceCache(source.cachedCandidates)
            : null;
        const candidates = full ?? partial?.candidates ?? [];

        for (const candidate of candidates) {
          const trackId = clean(candidate.spotifyTrackId);
          const artistId = clean(candidate.primaryArtistId);
          const artistName = clean(candidate.primaryArtistName);
          if (!trackId || !artistId || !artistName) continue;
          if (!refByTrackId.has(trackId)) continue;

          const bucket = observations.get(trackId) ?? [];
          bucket.push({
            sourcePlaylistId: source.id,
            observedAt: source.cacheUpdatedAt,
            primaryArtistId: artistId,
            primaryArtistName: artistName,
            trackName: candidate.title,
            albumName: clean(candidate.albumName),
            durationMs: candidate.durationMs,
          });
          observations.set(trackId, bucket);
        }
      }

      const rows: TextualPairTrack[] = [];
      for (const ref of refs) {
        const trackObservations = observations.get(ref.providerTrackId) ?? [];
        const chosen = [...trackObservations].sort((a, b) => {
          const time =
            (b.observedAt?.getTime() ?? 0) -
            (a.observedAt?.getTime() ?? 0);
          return (
            time ||
            a.sourcePlaylistId.localeCompare(b.sourcePlaylistId)
          );
        })[0];

        const canonicalArtistId =
          ref.recording.song.primaryArtist.providerRefs[0]?.providerArtistId ??
          null;
        const primaryArtistId =
          chosen?.primaryArtistId ?? canonicalArtistId;
        const primaryArtistName =
          chosen?.primaryArtistName ??
          clean(ref.recording.song.primaryArtist.canonicalName);
        const trackName =
          chosen?.trackName ?? clean(ref.recording.song.canonicalTitle);

        if (!primaryArtistId || !primaryArtistName || !trackName) continue;

        const albumName = chosen?.albumName ?? null;
        const durationMs = chosen?.durationMs ?? 0;
        rows.push({
          providerTrackId: ref.providerTrackId,
          recordingIdentityId: ref.recordingIdentityId,
          primaryArtistId,
          primaryArtistName,
          trackName,
          albumName,
          durationMs,
          versionTrait: classifyShadowResolverVersion({
            trackName,
            albumName,
          }),
        });
      }

      const groups = new Map<string, TextualPairTrack[]>();
      for (const row of rows) {
        const baseTitle = deriveBaseTitleSignal(row.trackName);
        if (!baseTitle) continue;
        const key = `${row.primaryArtistId}\u0000${baseTitle}`;
        const bucket = groups.get(key) ?? [];
        bucket.push(row);
        groups.set(key, bucket);
      }

      const pairs: TextualPair[] = [];
      for (const group of groups.values()) {
        const sorted = [...group].sort((a, b) =>
          a.providerTrackId.localeCompare(b.providerTrackId),
        );
        for (let i = 0; i < sorted.length; i += 1) {
          for (let j = i + 1; j < sorted.length; j += 1) {
            const left = sorted[i]!;
            const right = sorted[j]!;
            if (
              left.recordingIdentityId === right.recordingIdentityId
            ) {
              continue;
            }
            pairs.push({ left, right });
          }
        }
      }

      return pairs.sort((a, b) => {
        const leftKey = `${a.left.providerTrackId}\u0000${a.right.providerTrackId}`;
        const rightKey = `${b.left.providerTrackId}\u0000${b.right.providerTrackId}`;
        return leftKey.localeCompare(rightKey);
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function abstain(
  userId: string,
  abstentionReason: StrongIdentifierShadowAbstentionReport["abstentionReason"],
  baseline: StrongIdentifierShadowAbstentionReport["baseline"],
): StrongIdentifierShadowAbstentionReport {
  return {
    gate: "3B",
    mode: "SHADOW_PROVIDER_ENRICHMENT_ABSTAINED",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: false,
      identityWrites: false,
      canonicalWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
    },
    abstentionReason,
    baseline,
  };
}

function clearlyDifferentRecording(
  left: ShadowResolverVersionTrait,
  right: ShadowResolverVersionTrait,
): boolean {
  if (left === right) return false;
  const concrete = new Set<ShadowResolverVersionTrait>([
    "LIVE",
    "ACOUSTIC",
    "REMIX",
    "DEMO",
  ]);
  return concrete.has(left) || concrete.has(right);
}

function recordingVersionConflict(
  left: ShadowResolverVersionTrait,
  right: ShadowResolverVersionTrait,
): boolean {
  if (left === right || left === "UNKNOWN" || right === "UNKNOWN") {
    return false;
  }
  if (
    (left === "STANDARD" && right === "REMASTER") ||
    (left === "REMASTER" && right === "STANDARD")
  ) {
    return false;
  }
  return clearlyDifferentRecording(left, right);
}

function durationStronglyConflicts(left: number, right: number): boolean {
  if (left <= 0 || right <= 0) return false;
  const delta = Math.abs(left - right);
  return delta > Math.max(10_000, Math.min(left, right) * 0.05);
}

function countOutcome(
  rows: readonly StrongIdentifierPairResult[],
  predicate: (row: StrongIdentifierPairResult) => boolean,
): number {
  return rows.filter(predicate).length;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
