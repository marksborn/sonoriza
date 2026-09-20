import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { firstPartySpotifyTrackSubjectKey } from "@/services/music-preference/first-party-planner-preferences";
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
  analyzeGate4APair,
  type Gate4APairAnalysis,
  type Gate4ATrackPreferenceObservation,
} from "./canonical-preference-shadow";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
  runMusicIdentityShadowResolverReport,
  type ShadowResolverVersionTrait,
} from "./shadow-resolver-report";

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

type LoadedPreference = {
  subjectKey: string;
  policy: PlaybackPreferencePolicy;
  source: FirstPartyPreferenceSource;
};

export type Gate4BPreferenceState =
  | "NO_EXPLICIT_TRACK_PREFERENCE"
  | "IDENTICAL_EXPLICIT_TRACK_PREFERENCE"
  | "PREFERENCE_PRESENCE_DIVERGENCE"
  | "PREFERENCE_POLICY_DIVERGENCE"
  | "PREFERENCE_SOURCE_DIVERGENCE";

export type Gate4BComponentDecision =
  | "SAFE_CANONICAL_COMPONENT"
  | "BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE"
  | "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION"
  | "BLOCKED_DURATION_CLOSURE"
  | "BLOCKED_PREFERENCE_SEMANTICS";

export type Gate4BComponent = Readonly<{
  componentId: string;
  memberProviderTrackIds: string[];
  legacyRecordingIdentityIds: string[];
  memberCount: number;
  legacyRecordingCount: number;
  candidateEdgeCount: number;
  internalPairCount: number;
  expectedInternalPairCount: number;
  safeInternalPairs: number;
  blockedInternalPairs: number;
  normalizedIsrcs: string[];
  tracksMissingIsrc: number;
  minProviderDurationMs: number | null;
  maxProviderDurationMs: number | null;
  maxDurationDeltaMs: number | null;
  tracksMissingProviderDuration: number;
  preferenceState: Gate4BPreferenceState;
  explicitPreferencePolicies: PlaybackPreferencePolicy[];
  explicitPreferenceSources: FirstPartyPreferenceSource[];
  containsExcludedPreference: boolean;
  componentDecision: Gate4BComponentDecision;
  legacy: {
    recordingIdentityCount: number;
  };
  canonicalShadow: {
    hypotheticalRecordingCount: number;
    representativeRecordingIdentityId: null;
    representativeProviderTrackId: null;
    representativeSelection: "NOT_SELECTED_IN_GATE4B";
  };
}>;

export type MusicIdentityCanonicalComponentClosureShadowReport = {
  gate: "4B";
  mode: "SHADOW_CANONICAL_COMPONENT_CLOSURE_READ_ONLY";
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
    representativeSelection: false;
    likedTrackPreferenceRead: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
    basis: "GATE4A_PAIR_SEMANTICS_PLUS_FULL_COMPONENT_CLOSURE";
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
    preferenceSafeCandidatePairs: number;
    preferenceConflictCandidatePairs: number;
    componentCount: number;
    safeComponents: number;
    blockedComponents: number;
    transitiveComponents: number;
    internalContradictionComponents: number;
    durationBlockedComponents: number;
    preferenceBlockedComponents: number;
    incompleteEvidenceComponents: number;
    largestComponentSize: number;
    legacyRecordingIdentitiesInCandidateComponents: number;
    hypotheticalRecordingIdentitiesAfter: number;
    hypotheticalReduction: number;
    samples: Gate4BComponent[];
  };
};

export type CanonicalComponentClosureShadowAbstentionReport = {
  gate: "4B";
  mode: "SHADOW_CANONICAL_COMPONENT_CLOSURE_ABSTAINED";
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
    representativeSelection: false;
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

type TrackObservation = Gate4APairAnalysis["left"];

export function buildGate4BComponents(
  pairAnalyses: readonly Gate4APairAnalysis[],
): Gate4BComponent[] {
  const candidateEdges = pairAnalyses.filter(
    (row) => row.identityDecision === "CANONICAL_RECORDING_CANDIDATE",
  );
  if (candidateEdges.length === 0) return [];

  const trackById = new Map<string, TrackObservation>();
  const inconsistentTrackIds = new Set<string>();
  for (const row of pairAnalyses) {
    registerTrackObservation(trackById, inconsistentTrackIds, row.left);
    registerTrackObservation(trackById, inconsistentTrackIds, row.right);
  }

  const parent = new Map<string, string>();
  const ensure = (id: string) => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const find = (id: string): string => {
    ensure(id);
    const current = parent.get(id)!;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    parent.set(second!, first!);
  };

  for (const edge of candidateEdges) {
    ensure(edge.left.providerTrackId);
    ensure(edge.right.providerTrackId);
    union(edge.left.providerTrackId, edge.right.providerTrackId);
  }

  const membersByRoot = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const bucket = membersByRoot.get(root) ?? [];
    bucket.push(id);
    membersByRoot.set(root, bucket);
  }

  const components: Gate4BComponent[] = [];
  for (const memberIdsRaw of membersByRoot.values()) {
    const memberProviderTrackIds = [...new Set(memberIdsRaw)].sort();
    if (memberProviderTrackIds.length < 2) continue;
    const memberSet = new Set(memberProviderTrackIds);
    const internalPairs = pairAnalyses.filter(
      (row) =>
        memberSet.has(row.left.providerTrackId) &&
        memberSet.has(row.right.providerTrackId),
    );
    const expectedInternalPairCount =
      (memberProviderTrackIds.length * (memberProviderTrackIds.length - 1)) / 2;
    const candidateInternalPairs = internalPairs.filter(
      (row) => row.identityDecision === "CANONICAL_RECORDING_CANDIDATE",
    );
    const safeInternalPairs = internalPairs.filter(
      (row) => row.activationDecision === "SAFE_FOR_FUTURE_DEDUPE_COMPARISON",
    ).length;

    const observations = memberProviderTrackIds
      .map((id) => trackById.get(id) ?? null)
      .filter((row): row is TrackObservation => row !== null);
    const legacyRecordingIdentityIds = [
      ...new Set(observations.map((row) => row.recordingIdentityId)),
    ].sort();
    const normalizedIsrcs = [
      ...new Set(
        observations
          .map((row) => normalizeIsrc(row.isrc))
          .filter((value): value is string => value !== null),
      ),
    ].sort();
    const tracksMissingIsrc = observations.filter(
      (row) => normalizeIsrc(row.isrc) === null,
    ).length;
    const durations = observations
      .map((row) => positiveDuration(row.providerDurationMs))
      .filter((value): value is number => value !== null);
    const tracksMissingProviderDuration = observations.length - durations.length;
    const minProviderDurationMs = durations.length > 0 ? Math.min(...durations) : null;
    const maxProviderDurationMs = durations.length > 0 ? Math.max(...durations) : null;
    const maxDurationDeltaMs =
      minProviderDurationMs !== null && maxProviderDurationMs !== null
        ? maxProviderDurationMs - minProviderDurationMs
        : null;
    const preferenceState = classifyComponentPreference(observations);
    const explicitPreferences = observations
      .map((row) => row.preference)
      .filter((value): value is Gate4ATrackPreferenceObservation => value !== null);
    const explicitPreferencePolicies = [
      ...new Set(explicitPreferences.map((preference) => preference.policy)),
    ].sort();
    const explicitPreferenceSources = [
      ...new Set(explicitPreferences.map((preference) => preference.source)),
    ].sort();
    const containsExcludedPreference = explicitPreferences.some(
      (preference) => preference.policy === "EXCLUDED",
    );

    const incompleteInternalEvidence =
      observations.length !== memberProviderTrackIds.length ||
      internalPairs.length !== expectedInternalPairCount;
    const inconsistentTrackObservation = memberProviderTrackIds.some((id) =>
      inconsistentTrackIds.has(id),
    );
    const identityContradiction = internalPairs.some(
      (row) => row.identityDecision !== "CANONICAL_RECORDING_CANDIDATE",
    );
    const isrcClosureConflict =
      tracksMissingIsrc > 0 || normalizedIsrcs.length !== 1;
    const durationClosureConflict =
      tracksMissingProviderDuration > 0 ||
      minProviderDurationMs === null ||
      maxProviderDurationMs === null ||
      durationStronglyConflicts(minProviderDurationMs, maxProviderDurationMs);
    const preferenceConflict =
      preferenceState !== "NO_EXPLICIT_TRACK_PREFERENCE" &&
      preferenceState !== "IDENTICAL_EXPLICIT_TRACK_PREFERENCE";

    let componentDecision: Gate4BComponentDecision;
    if (incompleteInternalEvidence) {
      componentDecision = "BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE";
    } else if (
      inconsistentTrackObservation ||
      identityContradiction ||
      isrcClosureConflict
    ) {
      componentDecision = "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION";
    } else if (durationClosureConflict) {
      componentDecision = "BLOCKED_DURATION_CLOSURE";
    } else if (preferenceConflict) {
      componentDecision = "BLOCKED_PREFERENCE_SEMANTICS";
    } else {
      componentDecision = "SAFE_CANONICAL_COMPONENT";
    }

    const legacyRecordingCount = legacyRecordingIdentityIds.length;
    components.push({
      componentId: componentId(memberProviderTrackIds),
      memberProviderTrackIds,
      legacyRecordingIdentityIds,
      memberCount: memberProviderTrackIds.length,
      legacyRecordingCount,
      candidateEdgeCount: candidateInternalPairs.length,
      internalPairCount: internalPairs.length,
      expectedInternalPairCount,
      safeInternalPairs,
      blockedInternalPairs: internalPairs.length - safeInternalPairs,
      normalizedIsrcs,
      tracksMissingIsrc,
      minProviderDurationMs,
      maxProviderDurationMs,
      maxDurationDeltaMs,
      tracksMissingProviderDuration,
      preferenceState,
      explicitPreferencePolicies,
      explicitPreferenceSources,
      containsExcludedPreference,
      componentDecision,
      legacy: {
        recordingIdentityCount: legacyRecordingCount,
      },
      canonicalShadow: {
        hypotheticalRecordingCount:
          componentDecision === "SAFE_CANONICAL_COMPONENT"
            ? 1
            : legacyRecordingCount,
        representativeRecordingIdentityId: null,
        representativeProviderTrackId: null,
        representativeSelection: "NOT_SELECTED_IN_GATE4B",
      },
    });
  }

  return components.sort(compareComponents);
}

export async function runMusicIdentityCanonicalComponentClosureShadow(
  userIdInput: string,
  options: { provider?: ProviderLookup } = {},
): Promise<
  | MusicIdentityCanonicalComponentClosureShadowReport
  | CanonicalComponentClosureShadowAbstentionReport
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

  const input = await collectGate4BInput(userId);
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

  const pairAnalyses = input.pairs.map((pair) =>
    analyzeGate4APair({
      pair,
      leftLookup: lookupByRequestedId.get(pair.left.providerTrackId) ?? null,
      rightLookup: lookupByRequestedId.get(pair.right.providerTrackId) ?? null,
      leftPreference: preferenceForTrack(
        preferenceBySubjectKey,
        pair.left.providerTrackId,
      ),
      rightPreference: preferenceForTrack(
        preferenceBySubjectKey,
        pair.right.providerTrackId,
      ),
    }),
  );
  const components = buildGate4BComponents(pairAnalyses);
  const candidatePairs = pairAnalyses.filter(
    (row) => row.identityDecision === "CANONICAL_RECORDING_CANDIDATE",
  );
  const matchedPreferenceKeys = new Set<string>();
  for (const trackId of trackIds) {
    const key = firstPartySpotifyTrackSubjectKey(trackId);
    if (preferenceBySubjectKey.has(key)) matchedPreferenceKeys.add(key);
  }
  const returnedTracks = lookups.filter((lookup) => lookup.track !== null);
  const safeComponents = components.filter(
    (component) => component.componentDecision === "SAFE_CANONICAL_COMPONENT",
  );
  const legacyRecordingIdentitiesInCandidateComponents = components.reduce(
    (sum, component) => sum + component.legacyRecordingCount,
    0,
  );
  const hypotheticalRecordingIdentitiesAfter = components.reduce(
    (sum, component) => sum + component.canonicalShadow.hypotheticalRecordingCount,
    0,
  );

  return {
    gate: "4B",
    mode: "SHADOW_CANONICAL_COMPONENT_CLOSURE_READ_ONLY",
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
      representativeSelection: false,
      likedTrackPreferenceRead: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
      basis: "GATE4A_PAIR_SEMANTICS_PLUS_FULL_COMPONENT_CLOSURE",
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
      tracksWithIsrc: returnedTracks.filter(
        (lookup) => normalizeIsrc(lookup.track?.isrc) !== null,
      ).length,
      tracksWithDuration: returnedTracks.filter(
        (lookup) => positiveDuration(lookup.track?.durationMs) !== null,
      ).length,
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
      canonicalRecordingCandidatePairs: candidatePairs.length,
      identityBlockedPairs: pairAnalyses.length - candidatePairs.length,
      preferenceSafeCandidatePairs: candidatePairs.filter(
        (row) => row.activationDecision === "SAFE_FOR_FUTURE_DEDUPE_COMPARISON",
      ).length,
      preferenceConflictCandidatePairs: candidatePairs.filter(
        (row) => row.activationDecision === "BLOCKED_PREFERENCE_SEMANTICS",
      ).length,
      componentCount: components.length,
      safeComponents: safeComponents.length,
      blockedComponents: components.length - safeComponents.length,
      transitiveComponents: components.filter((component) => component.memberCount > 2)
        .length,
      internalContradictionComponents: countDecision(
        components,
        "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION",
      ),
      durationBlockedComponents: countDecision(
        components,
        "BLOCKED_DURATION_CLOSURE",
      ),
      preferenceBlockedComponents: countDecision(
        components,
        "BLOCKED_PREFERENCE_SEMANTICS",
      ),
      incompleteEvidenceComponents: countDecision(
        components,
        "BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE",
      ),
      largestComponentSize: components.reduce(
        (max, component) => Math.max(max, component.memberCount),
        0,
      ),
      legacyRecordingIdentitiesInCandidateComponents,
      hypotheticalRecordingIdentitiesAfter,
      hypotheticalReduction:
        legacyRecordingIdentitiesInCandidateComponents -
        hypotheticalRecordingIdentitiesAfter,
      samples: [...components].sort(compareComponents).slice(0, SAMPLE_LIMIT),
    },
  };
}

async function collectGate4BInput(
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
        pairs: pairs.sort((a, b) => pairKey(a).localeCompare(pairKey(b))),
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

function registerTrackObservation(
  trackById: Map<string, TrackObservation>,
  inconsistentTrackIds: Set<string>,
  observation: TrackObservation,
): void {
  const existing = trackById.get(observation.providerTrackId);
  if (!existing) {
    trackById.set(observation.providerTrackId, observation);
    return;
  }
  if (!sameTrackObservation(existing, observation)) {
    inconsistentTrackIds.add(observation.providerTrackId);
  }
}

function sameTrackObservation(
  left: TrackObservation,
  right: TrackObservation,
): boolean {
  return (
    left.recordingIdentityId === right.recordingIdentityId &&
    normalizeIsrc(left.isrc) === normalizeIsrc(right.isrc) &&
    positiveDuration(left.providerDurationMs) === positiveDuration(right.providerDurationMs) &&
    left.preference?.policy === right.preference?.policy &&
    left.preference?.source === right.preference?.source
  );
}

function classifyComponentPreference(
  observations: readonly TrackObservation[],
): Gate4BPreferenceState {
  const preferences = observations.map((row) => row.preference);
  const present = preferences.filter(
    (value): value is Gate4ATrackPreferenceObservation => value !== null,
  );
  if (present.length === 0) return "NO_EXPLICIT_TRACK_PREFERENCE";
  if (present.length !== preferences.length) return "PREFERENCE_PRESENCE_DIVERGENCE";
  const policies = new Set(present.map((preference) => preference.policy));
  if (policies.size !== 1) return "PREFERENCE_POLICY_DIVERGENCE";
  const sources = new Set(present.map((preference) => preference.source));
  if (sources.size !== 1) return "PREFERENCE_SOURCE_DIVERGENCE";
  return "IDENTICAL_EXPLICIT_TRACK_PREFERENCE";
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

function normalizeIsrc(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  return normalized || null;
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

function componentId(memberProviderTrackIds: readonly string[]): string {
  const digest = createHash("sha256")
    .update(memberProviderTrackIds.join("\u0000"))
    .digest("hex")
    .slice(0, 16);
  return `gate4b:${digest}`;
}

function countDecision(
  components: readonly Gate4BComponent[],
  decision: Gate4BComponentDecision,
): number {
  return components.filter((component) => component.componentDecision === decision).length;
}

function compareComponents(left: Gate4BComponent, right: Gate4BComponent): number {
  const rank = (component: Gate4BComponent) =>
    component.componentDecision === "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION"
      ? 0
      : component.componentDecision === "BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE"
        ? 1
        : component.componentDecision === "BLOCKED_DURATION_CLOSURE"
          ? 2
          : component.componentDecision === "BLOCKED_PREFERENCE_SEMANTICS"
            ? 3
            : 4;
  return (
    rank(left) - rank(right) ||
    right.memberCount - left.memberCount ||
    left.componentId.localeCompare(right.componentId)
  );
}

function pairKey(pair: TextualPair): string {
  return `${pair.left.providerTrackId}\u0000${pair.right.providerTrackId}`;
}

function abstain(
  userId: string,
  abstentionReason: CanonicalComponentClosureShadowAbstentionReport["abstentionReason"],
  baseline: CanonicalComponentClosureShadowAbstentionReport["baseline"],
): CanonicalComponentClosureShadowAbstentionReport {
  return {
    gate: "4B",
    mode: "SHADOW_CANONICAL_COMPONENT_CLOSURE_ABSTAINED",
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
      representativeSelection: false,
      likedTrackPreferenceRead: false,
    },
    abstentionReason,
    baseline,
  };
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}
