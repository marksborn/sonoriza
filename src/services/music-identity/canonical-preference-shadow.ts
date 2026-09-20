import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  firstPartySpotifyTrackSubjectKey,
} from "@/services/music-preference/first-party-planner-preferences";
import type {
  FirstPartyPreferenceSource,
  PlaybackPreferencePolicy,
} from "@/services/music-preference/first-party-playback-preference";
import {
  SpotifyCatalogSearchClient,
  type SpotifyCatalogTrackLookup,
} from "@/services/spotify/catalog-search";
import {
  decodeMusicSourceCache,
  decodePartialMusicSourceCache,
} from "@/services/spotify/source-cache";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
  runMusicIdentityShadowResolverReport,
  type ShadowResolverVersionTrait,
} from "./shadow-resolver-report";
import { evaluatePair } from "./strong-identifier-enrichment-shadow";

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
  durationMs: number;
  versionTrait: ShadowResolverVersionTrait;
};

type TextualPair = {
  left: TextualPairTrack;
  right: TextualPairTrack;
};

export type Gate4ATrackPreferenceObservation = Readonly<{
  policy: PlaybackPreferencePolicy;
  source: FirstPartyPreferenceSource;
}>;

export type Gate4APreferenceCompatibility =
  | "SAFE_NO_EXPLICIT_TRACK_PREFERENCE"
  | "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE"
  | "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE"
  | "BLOCKED_PREFERENCE_POLICY_DIVERGENCE"
  | "BLOCKED_PREFERENCE_SOURCE_DIVERGENCE";

export type Gate4AIdentityDecision =
  | "CANONICAL_RECORDING_CANDIDATE"
  | "BLOCKED_STRONG_ID_EVIDENCE"
  | "BLOCKED_PROVIDER_DURATION_MISSING"
  | "BLOCKED_PROVIDER_DURATION_CONFLICT";

export type Gate4APairAnalysis = Readonly<{
  left: {
    providerTrackId: string;
    recordingIdentityId: string;
    primaryArtistName: string;
    trackName: string;
    isrc: string | null;
    providerDurationMs: number | null;
    preference: Gate4ATrackPreferenceObservation | null;
  };
  right: {
    providerTrackId: string;
    recordingIdentityId: string;
    primaryArtistName: string;
    trackName: string;
    isrc: string | null;
    providerDurationMs: number | null;
    preference: Gate4ATrackPreferenceObservation | null;
  };
  identityDecision: Gate4AIdentityDecision;
  strongIdOutcome:
    | "REVIEW_RECORDING_MERGE"
    | "KEEP_RECORDINGS_SEPARATE"
    | "DIFFERENT_ISRC_REVIEW_ONLY"
    | "STRONG_ID_CONFLICT_REVIEW_ONLY"
    | "INSUFFICIENT_STRONG_ID";
  providerDurationDeltaMs: number | null;
  preferenceCompatibility: Gate4APreferenceCompatibility | null;
  activationDecision:
    | "SAFE_FOR_FUTURE_DEDUPE_COMPARISON"
    | "BLOCKED_IDENTITY_EVIDENCE"
    | "BLOCKED_PREFERENCE_SEMANTICS";
  legacy: {
    providerRepresentationCount: 2;
    providerTrackIds: [string, string];
  };
  canonicalShadow: {
    hypotheticalRecordingCount: 1 | 2;
    representativeProviderTrackId: null;
    representativeSelection: "NOT_SELECTED_IN_GATE4A";
  };
}>;

export type MusicIdentityCanonicalPreferenceShadowReport = {
  gate: "4A";
  mode: "SHADOW_CANONICAL_DEDUPE_PREFERENCE_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: true;
    provider: "spotify";
    endpoint: "GET /tracks/{id}";
    identityWrites: false;
    canonicalWrites: false;
    preferenceWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    likedTrackPreferenceRead: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
    basis: "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC_DURATION_PLUS_FIRST_PARTY_TRACK_PREFERENCE";
  };
  baseline: {
    interpretation:
      | "COMPLETE_PERSISTED_SNAPSHOT"
      | "LOWER_BOUND_PERSISTED_SNAPSHOT";
    pairCount: number;
    textualPossibleMatchPairs: number;
    sameSongDifferentRecordingPairs: number;
    reconstructedTextualPairs: number;
  };
  provider: {
    requestedDistinctTracks: number;
    returnedTracks: number;
    tracksWithIsrc: number;
    tracksWithDuration: number;
    nullTracks: number;
    metrics: unknown;
  };
  preferences: {
    loadedTrackPreferences: number;
    matchedTrackPreferences: number;
    unmatchedTrackPreferences: number;
  };
  comparison: {
    pairCount: number;
    canonicalRecordingCandidatePairs: number;
    identityBlockedPairs: number;
    preferenceSafePairs: number;
    preferenceConflictPairs: number;
    noPreferencePairs: number;
    identicalPreferencePairs: number;
    presenceConflictPairs: number;
    policyConflictPairs: number;
    sourceConflictPairs: number;
    excludedConflictPairs: number;
    samples: Gate4APairAnalysis[];
  };
};

export type CanonicalPreferenceShadowAbstentionReport = {
  gate: "4A";
  mode: "SHADOW_CANONICAL_DEDUPE_PREFERENCE_ABSTAINED";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: false;
    identityWrites: false;
    canonicalWrites: false;
    preferenceWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    likedTrackPreferenceRead: false;
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

type LoadedPreference = {
  subjectKey: string;
  policy: PlaybackPreferencePolicy;
  source: FirstPartyPreferenceSource;
};

export function classifyGate4APreferenceCompatibility(
  left: Gate4ATrackPreferenceObservation | null,
  right: Gate4ATrackPreferenceObservation | null,
): Gate4APreferenceCompatibility {
  if (!left && !right) return "SAFE_NO_EXPLICIT_TRACK_PREFERENCE";
  if (!left || !right) return "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE";
  if (left.policy !== right.policy) return "BLOCKED_PREFERENCE_POLICY_DIVERGENCE";
  if (left.source !== right.source) return "BLOCKED_PREFERENCE_SOURCE_DIVERGENCE";
  return "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE";
}

export function analyzeGate4APair(input: {
  pair: TextualPair;
  leftLookup: SpotifyCatalogTrackLookup | null;
  rightLookup: SpotifyCatalogTrackLookup | null;
  leftPreference: Gate4ATrackPreferenceObservation | null;
  rightPreference: Gate4ATrackPreferenceObservation | null;
}): Gate4APairAnalysis {
  const strong = evaluatePair(input.pair, input.leftLookup, input.rightLookup);
  const leftProviderDuration = positiveDuration(input.leftLookup?.track?.durationMs);
  const rightProviderDuration = positiveDuration(input.rightLookup?.track?.durationMs);
  const providerDurationDeltaMs =
    leftProviderDuration !== null && rightProviderDuration !== null
      ? Math.abs(leftProviderDuration - rightProviderDuration)
      : null;

  let identityDecision: Gate4AIdentityDecision;
  if (strong.outcome !== "REVIEW_RECORDING_MERGE") {
    identityDecision = "BLOCKED_STRONG_ID_EVIDENCE";
  } else if (leftProviderDuration === null || rightProviderDuration === null) {
    identityDecision = "BLOCKED_PROVIDER_DURATION_MISSING";
  } else if (durationStronglyConflicts(leftProviderDuration, rightProviderDuration)) {
    identityDecision = "BLOCKED_PROVIDER_DURATION_CONFLICT";
  } else {
    identityDecision = "CANONICAL_RECORDING_CANDIDATE";
  }

  const preferenceCompatibility =
    identityDecision === "CANONICAL_RECORDING_CANDIDATE"
      ? classifyGate4APreferenceCompatibility(
          input.leftPreference,
          input.rightPreference,
        )
      : null;
  const preferenceSafe =
    preferenceCompatibility === "SAFE_NO_EXPLICIT_TRACK_PREFERENCE" ||
    preferenceCompatibility === "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE";
  const activationDecision =
    identityDecision !== "CANONICAL_RECORDING_CANDIDATE"
      ? "BLOCKED_IDENTITY_EVIDENCE"
      : preferenceSafe
        ? "SAFE_FOR_FUTURE_DEDUPE_COMPARISON"
        : "BLOCKED_PREFERENCE_SEMANTICS";

  return {
    left: {
      providerTrackId: input.pair.left.providerTrackId,
      recordingIdentityId: input.pair.left.recordingIdentityId,
      primaryArtistName: input.pair.left.primaryArtistName,
      trackName: input.pair.left.trackName,
      isrc: strong.left.isrc,
      providerDurationMs: leftProviderDuration,
      preference: input.leftPreference,
    },
    right: {
      providerTrackId: input.pair.right.providerTrackId,
      recordingIdentityId: input.pair.right.recordingIdentityId,
      primaryArtistName: input.pair.right.primaryArtistName,
      trackName: input.pair.right.trackName,
      isrc: strong.right.isrc,
      providerDurationMs: rightProviderDuration,
      preference: input.rightPreference,
    },
    identityDecision,
    strongIdOutcome: strong.outcome,
    providerDurationDeltaMs,
    preferenceCompatibility,
    activationDecision,
    legacy: {
      providerRepresentationCount: 2,
      providerTrackIds: [
        input.pair.left.providerTrackId,
        input.pair.right.providerTrackId,
      ],
    },
    canonicalShadow: {
      hypotheticalRecordingCount:
        identityDecision === "CANONICAL_RECORDING_CANDIDATE" ? 1 : 2,
      representativeProviderTrackId: null,
      representativeSelection: "NOT_SELECTED_IN_GATE4A",
    },
  };
}

export async function runMusicIdentityCanonicalPreferenceShadow(
  userIdInput: string,
  options: { provider?: ProviderLookup } = {},
): Promise<
  MusicIdentityCanonicalPreferenceShadowReport | CanonicalPreferenceShadowAbstentionReport
> {
  const userId = clean(userIdInput);
  if (!userId) throw new Error("userId is required");

  const baseline = await runMusicIdentityShadowResolverReport(userId);
  const baselineSummary = {
    pairCount: baseline.resolution.pairCount,
    textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
    sameSongDifferentRecordingPairs: baseline.resolution.sameSongDifferentRecordingPairs,
    reconstructedTextualPairs: 0,
  };

  if (baseline.authority.interpretation !== "COMPLETE_PERSISTED_SNAPSHOT") {
    return abstain(userId, "INCOMPLETE_PERSISTED_SNAPSHOT", baselineSummary);
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

  const input = await collectGate4AInput(userId);
  baselineSummary.reconstructedTextualPairs = input.pairs.length;
  const expectedTextualPairs =
    baseline.resolution.textualPossibleMatchPairs +
    baseline.resolution.sameSongDifferentRecordingPairs;

  if (input.pairs.length !== expectedTextualPairs) {
    return abstain(userId, "PAIR_SET_MISMATCH", baselineSummary);
  }
  if (input.pairs.length > MAX_TEXTUAL_PAIRS) {
    return abstain(userId, "PAIR_LIMIT_EXCEEDED", baselineSummary);
  }

  const trackIds = distinct(
    input.pairs.flatMap((pair) => [
      pair.left.providerTrackId,
      pair.right.providerTrackId,
    ]),
  ).sort();
  if (trackIds.length > MAX_PROVIDER_TRACKS) {
    return abstain(userId, "TRACK_LIMIT_EXCEEDED", baselineSummary);
  }

  const provider = options.provider ?? (await SpotifyCatalogSearchClient.forUser(userId));
  const lookups = await provider.lookupTracksByIds(trackIds);
  const lookupByRequestedId = new Map(
    lookups.map((lookup) => [lookup.requestedTrackId, lookup]),
  );
  const preferenceBySubjectKey = new Map(
    input.preferences.map((preference) => [preference.subjectKey, preference]),
  );

  const pairAnalyses = input.pairs.map((pair) => {
    const leftPreference = preferenceForTrack(
      preferenceBySubjectKey,
      pair.left.providerTrackId,
    );
    const rightPreference = preferenceForTrack(
      preferenceBySubjectKey,
      pair.right.providerTrackId,
    );
    return analyzeGate4APair({
      pair,
      leftLookup: lookupByRequestedId.get(pair.left.providerTrackId) ?? null,
      rightLookup: lookupByRequestedId.get(pair.right.providerTrackId) ?? null,
      leftPreference,
      rightPreference,
    });
  });

  const matchedPreferenceKeys = new Set<string>();
  for (const trackId of trackIds) {
    const key = firstPartySpotifyTrackSubjectKey(trackId);
    if (preferenceBySubjectKey.has(key)) matchedPreferenceKeys.add(key);
  }

  const returnedTracks = lookups.filter((lookup) => lookup.track !== null);
  const tracksWithIsrc = returnedTracks.filter(
    (lookup) => clean(lookup.track?.isrc) !== null,
  ).length;
  const tracksWithDuration = returnedTracks.filter(
    (lookup) => positiveDuration(lookup.track?.durationMs) !== null,
  ).length;
  const candidates = pairAnalyses.filter(
    (row) => row.identityDecision === "CANONICAL_RECORDING_CANDIDATE",
  );
  const preferenceConflicts = candidates.filter(
    (row) => row.activationDecision === "BLOCKED_PREFERENCE_SEMANTICS",
  );

  return {
    gate: "4A",
    mode: "SHADOW_CANONICAL_DEDUPE_PREFERENCE_READ_ONLY",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: true,
      provider: "spotify",
      endpoint: "GET /tracks/{id}",
      identityWrites: false,
      canonicalWrites: false,
      preferenceWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      likedTrackPreferenceRead: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
      basis:
        "GATE3_TEXTUAL_PAIR_SET_PLUS_LIVE_SPOTIFY_ISRC_DURATION_PLUS_FIRST_PARTY_TRACK_PREFERENCE",
    },
    baseline: {
      interpretation: baseline.authority.interpretation,
      pairCount: baseline.resolution.pairCount,
      textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
      sameSongDifferentRecordingPairs: baseline.resolution.sameSongDifferentRecordingPairs,
      reconstructedTextualPairs: input.pairs.length,
    },
    provider: {
      requestedDistinctTracks: trackIds.length,
      returnedTracks: returnedTracks.length,
      tracksWithIsrc,
      tracksWithDuration,
      nullTracks: lookups.length - returnedTracks.length,
      metrics: provider.getMetrics?.() ?? null,
    },
    preferences: {
      loadedTrackPreferences: input.preferences.length,
      matchedTrackPreferences: matchedPreferenceKeys.size,
      unmatchedTrackPreferences: input.preferences.length - matchedPreferenceKeys.size,
    },
    comparison: {
      pairCount: pairAnalyses.length,
      canonicalRecordingCandidatePairs: candidates.length,
      identityBlockedPairs: pairAnalyses.length - candidates.length,
      preferenceSafePairs: candidates.filter(
        (row) => row.activationDecision === "SAFE_FOR_FUTURE_DEDUPE_COMPARISON",
      ).length,
      preferenceConflictPairs: preferenceConflicts.length,
      noPreferencePairs: countCompatibility(
        candidates,
        "SAFE_NO_EXPLICIT_TRACK_PREFERENCE",
      ),
      identicalPreferencePairs: countCompatibility(
        candidates,
        "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
      ),
      presenceConflictPairs: countCompatibility(
        candidates,
        "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE",
      ),
      policyConflictPairs: countCompatibility(
        candidates,
        "BLOCKED_PREFERENCE_POLICY_DIVERGENCE",
      ),
      sourceConflictPairs: countCompatibility(
        candidates,
        "BLOCKED_PREFERENCE_SOURCE_DIVERGENCE",
      ),
      excludedConflictPairs: preferenceConflicts.filter(hasExcludedConflict).length,
      samples: [...pairAnalyses]
        .sort(comparePairAnalysis)
        .slice(0, SAMPLE_LIMIT),
    },
  };
}

async function collectGate4AInput(
  userId: string,
): Promise<{ pairs: TextualPair[]; preferences: LoadedPreference[] }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const [sources, targets, refs, preferenceRows] = await Promise.all([
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
        tx.firstPartyPlaybackPreference.findMany({
          where: { userId, subjectType: "TRACK" },
          select: { subjectKey: true, policy: true, source: true },
          orderBy: { subjectKey: "asc" },
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
        for (const sourceId of scope.effectiveSourceIds) reachableSourceIds.add(sourceId);
      }

      const refByTrackId = new Map(refs.map((ref) => [ref.providerTrackId, ref]));
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
        if (source.kind !== "MUSIC" || !reachableSourceIds.has(source.id)) continue;
        const full = decodeMusicSourceCache(source.cachedCandidates);
        const partial =
          full === null ? decodePartialMusicSourceCache(source.cachedCandidates) : null;
        const candidates = full ?? partial?.candidates ?? [];
        for (const candidate of candidates) {
          const trackId = clean(candidate.spotifyTrackId);
          const artistId = clean(candidate.primaryArtistId);
          const artistName = clean(candidate.primaryArtistName);
          if (!trackId || !artistId || !artistName || !refByTrackId.has(trackId)) continue;
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
        const chosen = [...(observations.get(ref.providerTrackId) ?? [])].sort(
          (a, b) =>
            (b.observedAt?.getTime() ?? 0) - (a.observedAt?.getTime() ?? 0) ||
            a.sourcePlaylistId.localeCompare(b.sourcePlaylistId),
        )[0];
        const canonicalArtistId =
          ref.recording.song.primaryArtist.providerRefs[0]?.providerArtistId ?? null;
        const primaryArtistId = chosen?.primaryArtistId ?? canonicalArtistId;
        const primaryArtistName =
          chosen?.primaryArtistName ?? clean(ref.recording.song.primaryArtist.canonicalName);
        const trackName = chosen?.trackName ?? clean(ref.recording.song.canonicalTitle);
        if (!primaryArtistId || !primaryArtistName || !trackName) continue;
        const albumName = chosen?.albumName ?? null;
        rows.push({
          providerTrackId: ref.providerTrackId,
          recordingIdentityId: ref.recordingIdentityId,
          primaryArtistId,
          primaryArtistName,
          trackName,
          albumName,
          durationMs: chosen?.durationMs ?? 0,
          versionTrait: classifyShadowResolverVersion({ trackName, albumName }),
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
            if (left.recordingIdentityId === right.recordingIdentityId) continue;
            pairs.push({ left, right });
          }
        }
      }

      return {
        pairs: pairs.sort((a, b) =>
          `${a.left.providerTrackId}\u0000${a.right.providerTrackId}`.localeCompare(
            `${b.left.providerTrackId}\u0000${b.right.providerTrackId}`,
          ),
        ),
        preferences: preferenceRows.map((row) => ({
          subjectKey: row.subjectKey,
          policy: row.policy,
          source: row.source,
        })),
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function preferenceForTrack(
  preferences: ReadonlyMap<string, LoadedPreference>,
  providerTrackId: string,
): Gate4ATrackPreferenceObservation | null {
  const preference = preferences.get(firstPartySpotifyTrackSubjectKey(providerTrackId));
  return preference
    ? { policy: preference.policy, source: preference.source }
    : null;
}

function positiveDuration(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function durationStronglyConflicts(left: number, right: number): boolean {
  const delta = Math.abs(left - right);
  return delta > Math.max(10_000, Math.min(left, right) * 0.05);
}

function countCompatibility(
  rows: readonly Gate4APairAnalysis[],
  compatibility: Gate4APreferenceCompatibility,
): number {
  return rows.filter((row) => row.preferenceCompatibility === compatibility).length;
}

function hasExcludedConflict(row: Gate4APairAnalysis): boolean {
  if (row.activationDecision !== "BLOCKED_PREFERENCE_SEMANTICS") return false;
  const leftExcluded = row.left.preference?.policy === "EXCLUDED";
  const rightExcluded = row.right.preference?.policy === "EXCLUDED";
  return leftExcluded !== rightExcluded;
}

function comparePairAnalysis(a: Gate4APairAnalysis, b: Gate4APairAnalysis): number {
  const rank = (row: Gate4APairAnalysis) =>
    row.activationDecision === "BLOCKED_PREFERENCE_SEMANTICS"
      ? 0
      : row.activationDecision === "BLOCKED_IDENTITY_EVIDENCE"
        ? 1
        : 2;
  return (
    rank(a) - rank(b) ||
    a.left.providerTrackId.localeCompare(b.left.providerTrackId) ||
    a.right.providerTrackId.localeCompare(b.right.providerTrackId)
  );
}

function abstain(
  userId: string,
  abstentionReason: CanonicalPreferenceShadowAbstentionReport["abstentionReason"],
  baseline: CanonicalPreferenceShadowAbstentionReport["baseline"],
): CanonicalPreferenceShadowAbstentionReport {
  return {
    gate: "4A",
    mode: "SHADOW_CANONICAL_DEDUPE_PREFERENCE_ABSTAINED",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: false,
      identityWrites: false,
      canonicalWrites: false,
      preferenceWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      likedTrackPreferenceRead: false,
    },
    abstentionReason,
    baseline,
  };
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}
