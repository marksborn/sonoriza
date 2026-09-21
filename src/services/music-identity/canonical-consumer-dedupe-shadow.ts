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
  type Gate4ATrackPreferenceObservation,
} from "./canonical-preference-shadow";
import {
  buildGate4BComponents,
  type Gate4BComponent,
} from "./canonical-component-closure-shadow";
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

export type Gate4CCacheStatus =
  | "FULL_VALID"
  | "PARTIAL_VALID"
  | "MISSING"
  | "INVALID";

export type Gate4CConsumerOccurrence = Readonly<{
  sourcePlaylistId: string;
  providerTrackId: string;
  uri: string;
}>;

export type Gate4CComponentCollisionSample = Readonly<{
  componentId: string;
  componentDecision: "SAFE_CANONICAL_COMPONENT";
  preferenceState: Gate4BComponent["preferenceState"];
  containsExcludedPreference: boolean;
  memberProviderTrackIdsPresent: string[];
  allMemberProviderTrackIds: string[];
  memberSources: Array<{
    providerTrackId: string;
    sourcePlaylistIds: string[];
  }>;
  legacyDistinctProviderTracks: number;
  hypotheticalCanonicalRecordingKeys: 1;
  hypotheticalReduction: number;
  decision: "WOULD_COLLAPSE_COMPONENT";
  representativeProviderTrackId: null;
  representativeSelection: "NOT_SELECTED_IN_GATE4C";
}>;

export type Gate4CUniverseProjection = Readonly<{
  candidateOccurrences: number;
  distinctProviderTrackIds: number;
  distinctUris: number;
  safeComponentMappedTracks: number;
  blockedComponentTracks: number;
  legacyOnlyTracks: number;
  safeComponentsPresent: number;
  collisionComponents: number;
  collisionComponentIds: string[];
  redundantProviderTracksByCanonicalRecording: number;
  legacyDistinctRecordingKeys: number;
  hypotheticalCanonicalRecordingKeys: number;
  hypotheticalReduction: number;
  collisionSamples: Gate4CComponentCollisionSample[];
}>;

export type Gate4CTargetProjection = Gate4CUniverseProjection &
  Readonly<{
    targetPlaylistId: string;
    targetName: string;
    effectiveSourceIds: string[];
  }>;

export type Gate4CSourceProjection = Gate4CUniverseProjection &
  Readonly<{
    sourcePlaylistId: string;
    sourceName: string | null;
    cacheStatus: Gate4CCacheStatus;
    cacheUpdatedAt: string | null;
  }>;

export type MusicIdentityCanonicalConsumerDedupeShadowReport = {
  gate: "4C";
  mode: "SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: true;
    provider: "spotify";
    endpoint: "GET /tracks/{id}";
    consumerInputBasis: "TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION";
    legacyDedupeKey: "SPOTIFY_TRACK_ID";
    identityWrites: false;
    canonicalWrites: false;
    providerRefReassociation: false;
    preferenceWrites: false;
    preferencePropagation: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    spotifyPlaylistWrites: false;
    orderHashInfluence: false;
    representativeSelection: false;
    likedTrackPreferenceRead: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
    basis: "GATE4A_PAIR_ANALYSIS_PLUS_GATE4B_COMPONENT_CLOSURE_PLUS_PERSISTED_CONSUMER_INPUT";
  };
  baseline: {
    interpretation: "COMPLETE_PERSISTED_SNAPSHOT";
    pairCount: number;
    textualPossibleMatchPairs: number;
    sameSongDifferentRecordingPairs: number;
    reconstructedTextualPairs: number;
    snapshotFingerprint: string;
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
  components: {
    componentCount: number;
    safeComponents: number;
    blockedComponents: number;
    safeMemberTracks: number;
    blockedMemberTracks: number;
    safeComponentsWithExplicitPreference: number;
  };
  legacyInput: {
    enabledTargets: number;
    reachableMusicSources: number;
    candidateOccurrences: number;
    distinctProviderTrackIds: number;
    distinctUris: number;
  };
  comparison: {
    targetsEvaluated: number;
    targetsWithCanonicalCollision: number;
    sourcesEvaluated: number;
    sourcesWithCanonicalCollision: number;
    targetComponentCollisions: number;
    distinctCollidingComponentsAcrossTargets: number;
    targetLegacyDistinctRecordingKeys: number;
    targetHypotheticalCanonicalRecordingKeys: number;
    targetHypotheticalReduction: number;
    sourceComponentCollisions: number;
    sourceHypotheticalReduction: number;
    targets: Gate4CTargetProjection[];
    sources: Gate4CSourceProjection[];
    collisionSamples: Array<
      Gate4CComponentCollisionSample & {
        targetPlaylistId: string;
        targetName: string;
      }
    >;
  };
};

export type CanonicalConsumerDedupeShadowAbstentionReason =
  | "INCOMPLETE_PERSISTED_SNAPSHOT"
  | "BASELINE_ALREADY_HAS_STRONG_RECORDING_EVIDENCE"
  | "PAIR_SET_MISMATCH"
  | "PAIR_LIMIT_EXCEEDED"
  | "TRACK_LIMIT_EXCEEDED"
  | "NO_REACHABLE_MUSIC_INPUT"
  | "INCOMPLETE_CONSUMER_SNAPSHOT"
  | "MISSING_CONSUMER_SNAPSHOT_TIMESTAMP"
  | "PROVIDER_EVALUATION_FAILED"
  | "CONSUMER_INPUT_CHANGED_DURING_EVALUATION";

export type CanonicalConsumerDedupeShadowAbstentionReport = {
  gate: "4C";
  mode: "SHADOW_CANONICAL_CONSUMER_DEDUPE_ABSTAINED";
  userId: string;
  generatedAt: Date;
  authority: {
    providerEvaluationAttempted: boolean;
    providerCallsMayHaveOccurred: boolean;
    identityWrites: false;
    canonicalWrites: false;
    preferenceWrites: false;
    sourceCacheWrites: false;
    consumerActivation: false;
    plannerInfluence: false;
    spotifyPlaylistWrites: false;
    orderHashInfluence: false;
    representativeSelection: false;
  };
  abstentionReason: CanonicalConsumerDedupeShadowAbstentionReason;
  detail: string | null;
  baseline: {
    pairCount: number;
    textualPossibleMatchPairs: number;
    sameSongDifferentRecordingPairs: number;
    reconstructedTextualPairs: number;
    snapshotFingerprint: string | null;
  };
};

type Gate4CSourceInput = {
  id: string;
  name: string | null;
  cacheStatus: Gate4CCacheStatus;
  cacheUpdatedAt: Date | null;
  candidates: Array<{
    providerTrackId: string;
    uri: string;
  }>;
};

type Gate4CTargetInput = {
  id: string;
  name: string;
  effectiveSourceIds: string[];
};

type Gate4CCollectedInput = {
  pairs: TextualPair[];
  preferences: LoadedPreference[];
  sources: Gate4CSourceInput[];
  targets: Gate4CTargetInput[];
  snapshotFingerprint: string;
};

export function projectGate4CUniverse(input: {
  occurrences: readonly Gate4CConsumerOccurrence[];
  components: readonly Gate4BComponent[];
}): Gate4CUniverseProjection {
  const safeComponents = input.components.filter(
    (component) => component.componentDecision === "SAFE_CANONICAL_COMPONENT",
  );
  const blockedComponents = input.components.filter(
    (component) => component.componentDecision !== "SAFE_CANONICAL_COMPONENT",
  );
  const safeMembership = new Map<string, Gate4BComponent>();
  for (const component of safeComponents) {
    for (const trackId of component.memberProviderTrackIds) {
      const existing = safeMembership.get(trackId);
      if (existing && existing.componentId !== component.componentId) {
        throw new Error(`Gate 4C unsafe overlapping component membership for ${trackId}`);
      }
      safeMembership.set(trackId, component);
    }
  }
  const blockedTracks = new Set(
    blockedComponents.flatMap((component) => component.memberProviderTrackIds),
  );
  const distinctTrackIds = new Set(input.occurrences.map((row) => row.providerTrackId));
  const distinctUris = new Set(input.occurrences.map((row) => row.uri));
  const safeMappedTrackIds = new Set(
    [...distinctTrackIds].filter((trackId) => safeMembership.has(trackId)),
  );
  const blockedComponentTrackIds = new Set(
    [...distinctTrackIds].filter((trackId) => blockedTracks.has(trackId)),
  );

  const presentMembersByComponent = new Map<string, Set<string>>();
  for (const trackId of safeMappedTrackIds) {
    const component = safeMembership.get(trackId)!;
    const bucket = presentMembersByComponent.get(component.componentId) ?? new Set<string>();
    bucket.add(trackId);
    presentMembersByComponent.set(component.componentId, bucket);
  }

  const collisionSamples: Gate4CComponentCollisionSample[] = [];
  let redundantProviderTracksByCanonicalRecording = 0;
  const collidingComponentIds: string[] = [];
  for (const component of safeComponents) {
    const present = [...(presentMembersByComponent.get(component.componentId) ?? new Set())].sort();
    if (present.length < 2) continue;
    collidingComponentIds.push(component.componentId);
    redundantProviderTracksByCanonicalRecording += present.length - 1;
    if (collisionSamples.length < SAMPLE_LIMIT) {
      collisionSamples.push({
        componentId: component.componentId,
        componentDecision: "SAFE_CANONICAL_COMPONENT",
        preferenceState: component.preferenceState,
        containsExcludedPreference: component.containsExcludedPreference,
        memberProviderTrackIdsPresent: present,
        allMemberProviderTrackIds: [...component.memberProviderTrackIds],
        memberSources: present.map((providerTrackId) => ({
          providerTrackId,
          sourcePlaylistIds: [
            ...new Set(
              input.occurrences
                .filter((row) => row.providerTrackId === providerTrackId)
                .map((row) => row.sourcePlaylistId),
            ),
          ].sort(),
        })),
        legacyDistinctProviderTracks: present.length,
        hypotheticalCanonicalRecordingKeys: 1,
        hypotheticalReduction: present.length - 1,
        decision: "WOULD_COLLAPSE_COMPONENT",
        representativeProviderTrackId: null,
        representativeSelection: "NOT_SELECTED_IN_GATE4C",
      });
    }
  }

  const hypotheticalKeys = new Set<string>();
  for (const trackId of distinctTrackIds) {
    const component = safeMembership.get(trackId);
    hypotheticalKeys.add(component ? `component:${component.componentId}` : `legacy:${trackId}`);
  }

  return {
    candidateOccurrences: input.occurrences.length,
    distinctProviderTrackIds: distinctTrackIds.size,
    distinctUris: distinctUris.size,
    safeComponentMappedTracks: safeMappedTrackIds.size,
    blockedComponentTracks: blockedComponentTrackIds.size,
    legacyOnlyTracks: distinctTrackIds.size - safeMappedTrackIds.size,
    safeComponentsPresent: presentMembersByComponent.size,
    collisionComponents: collidingComponentIds.length,
    collisionComponentIds: [...collidingComponentIds].sort(),
    redundantProviderTracksByCanonicalRecording,
    legacyDistinctRecordingKeys: distinctTrackIds.size,
    hypotheticalCanonicalRecordingKeys: hypotheticalKeys.size,
    hypotheticalReduction: distinctTrackIds.size - hypotheticalKeys.size,
    collisionSamples: collisionSamples.sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    ),
  };
}

export async function runMusicIdentityCanonicalConsumerDedupeShadow(
  userIdInput: string,
  options: { provider?: ProviderLookup } = {},
): Promise<
  MusicIdentityCanonicalConsumerDedupeShadowReport | CanonicalConsumerDedupeShadowAbstentionReport
> {
  const userId = clean(userIdInput);
  if (!userId) throw new Error("userId is required");

  const baseline = await runMusicIdentityShadowResolverReport(userId);
  const baselineSummary = {
    pairCount: baseline.resolution.pairCount,
    textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
    sameSongDifferentRecordingPairs: baseline.resolution.sameSongDifferentRecordingPairs,
    reconstructedTextualPairs: 0,
    snapshotFingerprint: null as string | null,
  };

  if (baseline.authority.interpretation !== "COMPLETE_PERSISTED_SNAPSHOT") {
    return abstain(userId, "INCOMPLETE_PERSISTED_SNAPSHOT", baselineSummary, false, false);
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
      false,
      false,
    );
  }

  const input = await collectGate4CInput(userId);
  baselineSummary.reconstructedTextualPairs = input.pairs.length;
  baselineSummary.snapshotFingerprint = input.snapshotFingerprint;
  const expectedTextualPairs =
    baseline.resolution.textualPossibleMatchPairs +
    baseline.resolution.sameSongDifferentRecordingPairs;
  if (input.pairs.length !== expectedTextualPairs) {
    return abstain(userId, "PAIR_SET_MISMATCH", baselineSummary, false, false);
  }
  if (input.pairs.length > MAX_TEXTUAL_PAIRS) {
    return abstain(userId, "PAIR_LIMIT_EXCEEDED", baselineSummary, false, false);
  }
  if (input.sources.length === 0) {
    return abstain(userId, "NO_REACHABLE_MUSIC_INPUT", baselineSummary, false, false);
  }
  if (input.sources.some((source) => source.cacheStatus !== "FULL_VALID")) {
    return abstain(userId, "INCOMPLETE_CONSUMER_SNAPSHOT", baselineSummary, false, false);
  }
  if (input.sources.some((source) => source.cacheUpdatedAt === null)) {
    return abstain(
      userId,
      "MISSING_CONSUMER_SNAPSHOT_TIMESTAMP",
      baselineSummary,
      false,
      false,
    );
  }

  const trackIds = distinct(
    input.pairs.flatMap((pair) => [
      pair.left.providerTrackId,
      pair.right.providerTrackId,
    ]),
  ).sort();
  if (trackIds.length > MAX_PROVIDER_TRACKS) {
    return abstain(userId, "TRACK_LIMIT_EXCEEDED", baselineSummary, false, false);
  }

  let provider: ProviderLookup;
  let lookups: SpotifyCatalogTrackLookup[];
  try {
    provider = options.provider ?? (await SpotifyCatalogSearchClient.forUser(userId));
    lookups = await provider.lookupTracksByIds(trackIds);
  } catch (error) {
    return abstain(
      userId,
      "PROVIDER_EVALUATION_FAILED",
      baselineSummary,
      true,
      true,
      error instanceof Error ? error.message : String(error),
    );
  }

  const postInput = await collectGate4CInput(userId);
  if (postInput.snapshotFingerprint !== input.snapshotFingerprint) {
    return abstain(
      userId,
      "CONSUMER_INPUT_CHANGED_DURING_EVALUATION",
      baselineSummary,
      true,
      true,
    );
  }

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
      leftPreference: preferenceForTrack(preferenceBySubjectKey, pair.left.providerTrackId),
      rightPreference: preferenceForTrack(preferenceBySubjectKey, pair.right.providerTrackId),
    }),
  );
  const components = buildGate4BComponents(pairAnalyses);
  const safeComponents = components.filter(
    (component) => component.componentDecision === "SAFE_CANONICAL_COMPONENT",
  );
  const blockedComponents = components.filter(
    (component) => component.componentDecision !== "SAFE_CANONICAL_COMPONENT",
  );

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const sourceProjections: Gate4CSourceProjection[] = input.sources
    .map((source) => {
      const projected = projectGate4CUniverse({
        occurrences: source.candidates.map((candidate) => ({
          sourcePlaylistId: source.id,
          providerTrackId: candidate.providerTrackId,
          uri: candidate.uri,
        })),
        components,
      });
      return {
        sourcePlaylistId: source.id,
        sourceName: source.name,
        cacheStatus: source.cacheStatus,
        cacheUpdatedAt: source.cacheUpdatedAt?.toISOString() ?? null,
        ...projected,
      };
    })
    .sort((a, b) => a.sourcePlaylistId.localeCompare(b.sourcePlaylistId));

  const targetProjections: Gate4CTargetProjection[] = input.targets
    .map((target) => {
      const occurrences = target.effectiveSourceIds.flatMap((sourceId) => {
        const source = sourceById.get(sourceId);
        return (source?.candidates ?? []).map((candidate) => ({
          sourcePlaylistId: sourceId,
          providerTrackId: candidate.providerTrackId,
          uri: candidate.uri,
        }));
      });
      const projected = projectGate4CUniverse({ occurrences, components });
      return {
        targetPlaylistId: target.id,
        targetName: target.name,
        effectiveSourceIds: [...target.effectiveSourceIds],
        ...projected,
      };
    })
    .sort((a, b) => a.targetPlaylistId.localeCompare(b.targetPlaylistId));

  const globalOccurrences = input.sources.flatMap((source) =>
    source.candidates.map((candidate) => ({
      sourcePlaylistId: source.id,
      providerTrackId: candidate.providerTrackId,
      uri: candidate.uri,
    })),
  );
  const globalProjection = projectGate4CUniverse({
    occurrences: globalOccurrences,
    components,
  });
  const collidingComponentIds = new Set(
    targetProjections.flatMap((target) => target.collisionComponentIds),
  );
  const matchedPreferenceKeys = new Set<string>();
  for (const trackId of trackIds) {
    const key = firstPartySpotifyTrackSubjectKey(trackId);
    if (preferenceBySubjectKey.has(key)) matchedPreferenceKeys.add(key);
  }
  const returnedTracks = lookups.filter((lookup) => lookup.track !== null);

  return {
    gate: "4C",
    mode: "SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: true,
      provider: "spotify",
      endpoint: "GET /tracks/{id}",
      consumerInputBasis: "TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION",
      legacyDedupeKey: "SPOTIFY_TRACK_ID",
      identityWrites: false,
      canonicalWrites: false,
      providerRefReassociation: false,
      preferenceWrites: false,
      preferencePropagation: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      spotifyPlaylistWrites: false,
      orderHashInfluence: false,
      representativeSelection: false,
      likedTrackPreferenceRead: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
      basis:
        "GATE4A_PAIR_ANALYSIS_PLUS_GATE4B_COMPONENT_CLOSURE_PLUS_PERSISTED_CONSUMER_INPUT",
    },
    baseline: {
      interpretation: "COMPLETE_PERSISTED_SNAPSHOT",
      pairCount: baseline.resolution.pairCount,
      textualPossibleMatchPairs: baseline.resolution.textualPossibleMatchPairs,
      sameSongDifferentRecordingPairs: baseline.resolution.sameSongDifferentRecordingPairs,
      reconstructedTextualPairs: input.pairs.length,
      snapshotFingerprint: input.snapshotFingerprint,
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
    components: {
      componentCount: components.length,
      safeComponents: safeComponents.length,
      blockedComponents: blockedComponents.length,
      safeMemberTracks: new Set(
        safeComponents.flatMap((component) => component.memberProviderTrackIds),
      ).size,
      blockedMemberTracks: new Set(
        blockedComponents.flatMap((component) => component.memberProviderTrackIds),
      ).size,
      safeComponentsWithExplicitPreference: safeComponents.filter(
        (component) =>
          component.preferenceState === "IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
      ).length,
    },
    legacyInput: {
      enabledTargets: input.targets.length,
      reachableMusicSources: input.sources.length,
      candidateOccurrences: globalProjection.candidateOccurrences,
      distinctProviderTrackIds: globalProjection.distinctProviderTrackIds,
      distinctUris: globalProjection.distinctUris,
    },
    comparison: {
      targetsEvaluated: targetProjections.length,
      targetsWithCanonicalCollision: targetProjections.filter(
        (target) => target.collisionComponents > 0,
      ).length,
      sourcesEvaluated: sourceProjections.length,
      sourcesWithCanonicalCollision: sourceProjections.filter(
        (source) => source.collisionComponents > 0,
      ).length,
      targetComponentCollisions: targetProjections.reduce(
        (sum, target) => sum + target.collisionComponents,
        0,
      ),
      distinctCollidingComponentsAcrossTargets: collidingComponentIds.size,
      targetLegacyDistinctRecordingKeys: targetProjections.reduce(
        (sum, target) => sum + target.legacyDistinctRecordingKeys,
        0,
      ),
      targetHypotheticalCanonicalRecordingKeys: targetProjections.reduce(
        (sum, target) => sum + target.hypotheticalCanonicalRecordingKeys,
        0,
      ),
      targetHypotheticalReduction: targetProjections.reduce(
        (sum, target) => sum + target.hypotheticalReduction,
        0,
      ),
      sourceComponentCollisions: sourceProjections.reduce(
        (sum, source) => sum + source.collisionComponents,
        0,
      ),
      sourceHypotheticalReduction: sourceProjections.reduce(
        (sum, source) => sum + source.hypotheticalReduction,
        0,
      ),
      targets: targetProjections,
      sources: sourceProjections,
      collisionSamples: targetProjections
        .flatMap((target) =>
          target.collisionSamples.map((sample) => ({
            ...sample,
            targetPlaylistId: target.targetPlaylistId,
            targetName: target.targetName,
          })),
        )
        .sort(
          (a, b) =>
            a.targetPlaylistId.localeCompare(b.targetPlaylistId) ||
            a.componentId.localeCompare(b.componentId),
        )
        .slice(0, SAMPLE_LIMIT),
    },
  };
}

async function collectGate4CInput(userId: string): Promise<Gate4CCollectedInput> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");

      const [user, sources, targets, refs, preferenceRows] = await Promise.all([
        tx.user.findUnique({ where: { id: userId }, select: { id: true } }),
        tx.sourcePlaylist.findMany({
          where: { userId },
          select: {
            id: true,
            name: true,
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
      if (!user) throw new Error(`Sonoriza user not found: ${userId}`);

      const scopeSources = sources.map((source) => ({
        id: source.id,
        enabled: source.enabled,
      }));
      const targetInputs: Gate4CTargetInput[] = [];
      const reachableSourceIds = new Set<string>();
      for (const target of targets) {
        const scope = resolveTargetSourceScope({
          targetPlaylistId: target.id,
          targetName: target.name,
          sourceScopeMode: target.sourceScopeMode,
          selectedSourceIds: target.sourceSelections.map((row) => row.sourcePlaylistId),
          sources: scopeSources,
        });
        const effectiveSourceIds = scope.effectiveSourceIds
          .filter((sourceId) =>
            sources.some((source) => source.id === sourceId && source.kind === "MUSIC"),
          )
          .sort();
        for (const sourceId of effectiveSourceIds) reachableSourceIds.add(sourceId);
        targetInputs.push({ id: target.id, name: target.name, effectiveSourceIds });
      }

      const consumerSources: Gate4CSourceInput[] = sources
        .filter((source) => source.kind === "MUSIC" && reachableSourceIds.has(source.id))
        .map((source) => {
          const full = decodeMusicSourceCache(source.cachedCandidates);
          const partial =
            full === null ? decodePartialMusicSourceCache(source.cachedCandidates) : null;
          const cacheStatus: Gate4CCacheStatus =
            full !== null
              ? "FULL_VALID"
              : partial !== null
                ? "PARTIAL_VALID"
                : source.cachedCandidates == null
                  ? "MISSING"
                  : "INVALID";
          const candidates = full ?? partial?.candidates ?? [];
          return {
            id: source.id,
            name: source.name,
            cacheStatus,
            cacheUpdatedAt: source.cacheUpdatedAt,
            candidates: candidates
              .map((candidate) => ({
                providerTrackId: clean(candidate.spotifyTrackId),
                uri: candidate.uri,
              }))
              .filter(
                (candidate): candidate is { providerTrackId: string; uri: string } =>
                  Boolean(candidate.providerTrackId),
              ),
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));

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
      const sortedTargets = targetInputs.sort((a, b) => a.id.localeCompare(b.id));
      const sortedPairs = pairs.sort((a, b) => pairKey(a).localeCompare(pairKey(b)));
      const preferences = preferenceRows.map((row) => ({
        subjectKey: row.subjectKey,
        policy: row.policy,
        source: row.source,
      }));
      const snapshotFingerprint = fingerprintSnapshot(
        sortedTargets,
        consumerSources,
        sortedPairs,
        preferences,
      );

      return {
        pairs: sortedPairs,
        preferences,
        sources: consumerSources,
        targets: sortedTargets,
        snapshotFingerprint,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function fingerprintSnapshot(
  targets: readonly Gate4CTargetInput[],
  sources: readonly Gate4CSourceInput[],
  pairs: readonly TextualPair[],
  preferences: readonly LoadedPreference[],
): string {
  const payload = {
    targets: targets.map((target) => ({
      id: target.id,
      name: target.name,
      effectiveSourceIds: target.effectiveSourceIds,
    })),
    sources: sources.map((source) => ({
      id: source.id,
      cacheStatus: source.cacheStatus,
      cacheUpdatedAt: source.cacheUpdatedAt?.toISOString() ?? null,
      candidates: source.candidates.map((candidate) => [
        candidate.providerTrackId,
        candidate.uri,
      ]),
    })),
    pairs: pairs.map((pair) => ({
      key: pairKey(pair),
      leftRecordingIdentityId: pair.left.recordingIdentityId,
      rightRecordingIdentityId: pair.right.recordingIdentityId,
      leftVersionTrait: pair.left.versionTrait,
      rightVersionTrait: pair.right.versionTrait,
    })),
    preferences: preferences.map((preference) => ({
      subjectKey: preference.subjectKey,
      policy: preference.policy,
      source: preference.source,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
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
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function pairKey(pair: TextualPair): string {
  return `${pair.left.providerTrackId}\u0000${pair.right.providerTrackId}`;
}

function abstain(
  userId: string,
  abstentionReason: CanonicalConsumerDedupeShadowAbstentionReason,
  baseline: CanonicalConsumerDedupeShadowAbstentionReport["baseline"],
  providerEvaluationAttempted: boolean,
  providerCallsMayHaveOccurred: boolean,
  detail: string | null = null,
): CanonicalConsumerDedupeShadowAbstentionReport {
  return {
    gate: "4C",
    mode: "SHADOW_CANONICAL_CONSUMER_DEDUPE_ABSTAINED",
    userId,
    generatedAt: new Date(),
    authority: {
      providerEvaluationAttempted,
      providerCallsMayHaveOccurred,
      identityWrites: false,
      canonicalWrites: false,
      preferenceWrites: false,
      sourceCacheWrites: false,
      consumerActivation: false,
      plannerInfluence: false,
      spotifyPlaylistWrites: false,
      orderHashInfluence: false,
      representativeSelection: false,
    },
    abstentionReason,
    detail,
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
