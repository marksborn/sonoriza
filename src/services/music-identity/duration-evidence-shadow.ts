import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeIsrcEvidence } from "@/services/music-identity/contracts";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
  runMusicIdentityShadowResolverReport,
  type ShadowResolverVersionTrait,
} from "@/services/music-identity/shadow-resolver-report";
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
const SAMPLE_LIMIT = 50;

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
  persistedDurationMs: number;
  versionTrait: ShadowResolverVersionTrait;
};

type TextualPair = {
  left: TextualPairTrack;
  right: TextualPairTrack;
};

export type DurationAvailability =
  | "COMPLETE"
  | "LEFT_MISSING"
  | "RIGHT_MISSING"
  | "BOTH_MISSING";

export type DurationEvidenceDiagnostic = {
  left: TextualPairTrack & {
    isrc: string;
    providerDurationMs: number;
    resolvedTrackId: string | null;
  };
  right: TextualPairTrack & {
    isrc: string;
    providerDurationMs: number;
    resolvedTrackId: string | null;
  };
  baselineKind:
    | "SAME_SONG_DIFFERENT_RECORDING"
    | "TEXTUAL_POSSIBLE_MATCH";
  persistedDurationAvailability: DurationAvailability;
  persistedDurationDeltaMs: number | null;
  providerDurationAvailability: DurationAvailability;
  providerDurationDeltaMs: number | null;
  providerStrongConflict: boolean | null;
};

export type MusicIdentityDurationEvidenceShadowReport = {
  gate: "3C";
  mode: "SHADOW_DURATION_EVIDENCE_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: true;
    provider: "spotify";
    endpoint: "GET /tracks/{id}";
    identityWrites: false;
    canonicalWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
    basis: "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC_AND_DURATION";
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
    tracksWithDuration: number;
    tracksMissingDuration: number;
    nullTracks: number;
    metrics: unknown;
  };
  diagnostics: {
    pairCount: number;
    sameIsrcPairs: number;
    sameIsrcTextualPossiblePairs: number;
    sameIsrcDifferentRecordingPairs: number;
    persistedDurationCompletePairs: number;
    persistedDurationMissingPairs: number;
    providerDurationCompletePairs: number;
    providerDurationMissingPairs: number;
    providerStrongConflictPairs: number;
    providerCompatiblePairs: number;
    persistedMissingButProviderCompatiblePairs: number;
    persistedMissingAndProviderConflictPairs: number;
    persistedCompleteButProviderConflictPairs: number;
    samples: DurationEvidenceDiagnostic[];
  };
};

export type DurationEvidenceShadowAbstentionReport = {
  gate: "3C";
  mode: "SHADOW_DURATION_EVIDENCE_ABSTAINED";
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

export async function runMusicIdentityDurationEvidenceShadow(
  userIdInput: string,
  options: { provider?: ProviderLookup } = {},
): Promise<
  MusicIdentityDurationEvidenceShadowReport | DurationEvidenceShadowAbstentionReport
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

  const sameIsrcDiagnostics = textualPairs
    .map((pair) =>
      evaluateDurationEvidence(
        pair,
        lookupByRequestedId.get(pair.left.providerTrackId) ?? null,
        lookupByRequestedId.get(pair.right.providerTrackId) ?? null,
      ),
    )
    .filter((row): row is DurationEvidenceDiagnostic => row !== null);

  const returnedTracks = lookups.filter((lookup) => lookup.track !== null);
  const tracksWithIsrc = returnedTracks.filter(
    (lookup) => normalizeIsrcEvidence(lookup.track?.isrc) !== null,
  ).length;
  const tracksWithDuration = returnedTracks.filter(
    (lookup) => (lookup.track?.durationMs ?? 0) > 0,
  ).length;

  const anomalySamples = sameIsrcDiagnostics.filter(
    (row) =>
      row.persistedDurationAvailability !== "COMPLETE" ||
      row.providerStrongConflict === true ||
      row.providerDurationAvailability !== "COMPLETE",
  );

  return {
    gate: "3C",
    mode: "SHADOW_DURATION_EVIDENCE_READ_ONLY",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: true,
      provider: "spotify",
      endpoint: "GET /tracks/{id}",
      identityWrites: false,
      canonicalWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
      basis: "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC_AND_DURATION",
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
      tracksWithDuration,
      tracksMissingDuration: returnedTracks.length - tracksWithDuration,
      nullTracks: lookups.length - returnedTracks.length,
      metrics: provider.getMetrics?.() ?? null,
    },
    diagnostics: {
      pairCount: textualPairs.length,
      sameIsrcPairs: sameIsrcDiagnostics.length,
      sameIsrcTextualPossiblePairs: count(
        sameIsrcDiagnostics,
        (row) => row.baselineKind === "TEXTUAL_POSSIBLE_MATCH",
      ),
      sameIsrcDifferentRecordingPairs: count(
        sameIsrcDiagnostics,
        (row) => row.baselineKind === "SAME_SONG_DIFFERENT_RECORDING",
      ),
      persistedDurationCompletePairs: count(
        sameIsrcDiagnostics,
        (row) => row.persistedDurationAvailability === "COMPLETE",
      ),
      persistedDurationMissingPairs: count(
        sameIsrcDiagnostics,
        (row) => row.persistedDurationAvailability !== "COMPLETE",
      ),
      providerDurationCompletePairs: count(
        sameIsrcDiagnostics,
        (row) => row.providerDurationAvailability === "COMPLETE",
      ),
      providerDurationMissingPairs: count(
        sameIsrcDiagnostics,
        (row) => row.providerDurationAvailability !== "COMPLETE",
      ),
      providerStrongConflictPairs: count(
        sameIsrcDiagnostics,
        (row) => row.providerStrongConflict === true,
      ),
      providerCompatiblePairs: count(
        sameIsrcDiagnostics,
        (row) => row.providerStrongConflict === false,
      ),
      persistedMissingButProviderCompatiblePairs: count(
        sameIsrcDiagnostics,
        (row) =>
          row.persistedDurationAvailability !== "COMPLETE" &&
          row.providerStrongConflict === false,
      ),
      persistedMissingAndProviderConflictPairs: count(
        sameIsrcDiagnostics,
        (row) =>
          row.persistedDurationAvailability !== "COMPLETE" &&
          row.providerStrongConflict === true,
      ),
      persistedCompleteButProviderConflictPairs: count(
        sameIsrcDiagnostics,
        (row) =>
          row.persistedDurationAvailability === "COMPLETE" &&
          row.providerStrongConflict === true,
      ),
      samples: anomalySamples.slice(0, SAMPLE_LIMIT),
    },
  };
}

export function evaluateDurationEvidence(
  pair: TextualPair,
  leftLookup: SpotifyCatalogTrackLookup | null,
  rightLookup: SpotifyCatalogTrackLookup | null,
): DurationEvidenceDiagnostic | null {
  const leftIsrc = normalizeIsrcEvidence(leftLookup?.track?.isrc) ?? null;
  const rightIsrc = normalizeIsrcEvidence(rightLookup?.track?.isrc) ?? null;
  if (!leftIsrc || !rightIsrc || leftIsrc !== rightIsrc) return null;

  const providerLeftDurationMs = Math.max(
    0,
    leftLookup?.track?.durationMs ?? 0,
  );
  const providerRightDurationMs = Math.max(
    0,
    rightLookup?.track?.durationMs ?? 0,
  );
  const persistedDurationAvailability = durationAvailability(
    pair.left.persistedDurationMs,
    pair.right.persistedDurationMs,
  );
  const providerDurationAvailability = durationAvailability(
    providerLeftDurationMs,
    providerRightDurationMs,
  );

  return {
    left: {
      ...pair.left,
      isrc: leftIsrc,
      providerDurationMs: providerLeftDurationMs,
      resolvedTrackId: leftLookup?.track?.id ?? null,
    },
    right: {
      ...pair.right,
      isrc: rightIsrc,
      providerDurationMs: providerRightDurationMs,
      resolvedTrackId: rightLookup?.track?.id ?? null,
    },
    baselineKind: clearlyDifferentRecording(
      pair.left.versionTrait,
      pair.right.versionTrait,
    )
      ? "SAME_SONG_DIFFERENT_RECORDING"
      : "TEXTUAL_POSSIBLE_MATCH",
    persistedDurationAvailability,
    persistedDurationDeltaMs: durationDeltaIfComplete(
      pair.left.persistedDurationMs,
      pair.right.persistedDurationMs,
    ),
    providerDurationAvailability,
    providerDurationDeltaMs: durationDeltaIfComplete(
      providerLeftDurationMs,
      providerRightDurationMs,
    ),
    providerStrongConflict:
      providerDurationAvailability === "COMPLETE"
        ? durationStronglyConflicts(
            providerLeftDurationMs,
            providerRightDurationMs,
          )
        : null,
  };
}

export function durationStronglyConflicts(
  leftDurationMs: number,
  rightDurationMs: number,
): boolean {
  if (leftDurationMs <= 0 || rightDurationMs <= 0) return false;
  const delta = Math.abs(leftDurationMs - rightDurationMs);
  return (
    delta >
    Math.max(10_000, Math.min(leftDurationMs, rightDurationMs) * 0.05)
  );
}

export function durationAvailability(
  leftDurationMs: number,
  rightDurationMs: number,
): DurationAvailability {
  const left = leftDurationMs > 0;
  const right = rightDurationMs > 0;
  if (left && right) return "COMPLETE";
  if (!left && !right) return "BOTH_MISSING";
  return left ? "RIGHT_MISSING" : "LEFT_MISSING";
}

function durationDeltaIfComplete(
  leftDurationMs: number,
  rightDurationMs: number,
): number | null {
  return leftDurationMs > 0 && rightDurationMs > 0
    ? Math.abs(leftDurationMs - rightDurationMs)
    : null;
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
        const persistedDurationMs = chosen?.durationMs ?? 0;
        rows.push({
          providerTrackId: ref.providerTrackId,
          recordingIdentityId: ref.recordingIdentityId,
          primaryArtistId,
          primaryArtistName,
          trackName,
          albumName,
          persistedDurationMs,
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
            if (left.recordingIdentityId === right.recordingIdentityId) {
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

function abstain(
  userId: string,
  abstentionReason: DurationEvidenceShadowAbstentionReport["abstentionReason"],
  baseline: DurationEvidenceShadowAbstentionReport["baseline"],
): DurationEvidenceShadowAbstentionReport {
  return {
    gate: "3C",
    mode: "SHADOW_DURATION_EVIDENCE_ABSTAINED",
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

function count<T>(rows: readonly T[], predicate: (row: T) => boolean): number {
  return rows.filter(predicate).length;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
