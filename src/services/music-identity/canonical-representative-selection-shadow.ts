import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { decodeMusicSourceCache } from "@/services/spotify/source-cache";
import { resolveTargetSourceScope } from "@/services/target-source-scope";
import {
  runMusicIdentityCanonicalConsumerDedupeShadow,
  type Gate4CComponentCollisionSample,
  type MusicIdentityCanonicalConsumerDedupeShadowReport,
} from "./canonical-consumer-dedupe-shadow";

const REPRESENTATIVE_POLICY = "LEGACY_FIRST_OCCURRENCE_V1" as const;
const CONSUMER_INPUT_BASIS =
  "TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION" as const;
const SOURCE_ORDER_AUTHORITY = "TARGET_SCOPE_EFFECTIVE_SOURCE_IDS_LEXICOGRAPHIC" as const;
const CACHE_ORDER_AUTHORITY = "PERSISTED_SOURCE_CACHE_CANDIDATE_ARRAY_INDEX" as const;
const SAMPLE_LIMIT = 50;

type Gate4DGate4CRunner = (
  userId: string,
) => ReturnType<typeof runMusicIdentityCanonicalConsumerDedupeShadow>;

export type Gate4DOrderedOccurrence = Readonly<{
  sourcePlaylistId: string;
  sourceOrder: number;
  cachePosition: number;
  providerTrackId: string;
  uri: string;
}>;

export type Gate4DSelection = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  componentId: string;
  policy: typeof REPRESENTATIVE_POLICY;
  preferenceState: Gate4CComponentCollisionSample["preferenceState"];
  containsExcludedPreference: boolean;
  memberProviderTrackIdsPresent: string[];
  representativeProviderTrackId: string;
  droppedProviderTrackIds: string[];
  representativeOccurrence: Gate4DOrderedOccurrence;
  memberFirstOccurrences: Array<{
    providerTrackId: string;
    firstOccurrence: Gate4DOrderedOccurrence;
    sourcePlaylistIds: string[];
  }>;
  decisiveCriterion: "SOURCE_ORDER" | "CACHE_POSITION" | "PROVIDER_TRACK_ID_TIE_BREAK";
  reasonChain: string[];
  representativeAppearsInMultipleSources: boolean;
  hypotheticalDrops: number;
  decision: "WOULD_KEEP_DROP";
}>;

export type Gate4DTargetSelection = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  effectiveSourceIds: string[];
  gate4cCollisionComponents: number;
  selectableCollisions: number;
  abstainedCollisions: number;
  hypotheticalDrops: number;
  distinctRepresentatives: number;
  selectionsDependingOnSourceOrder: number;
  selectionsDependingOnCachePosition: number;
  selectionsUsingProviderIdTieBreak: number;
  representativesAppearingInMultipleSources: number;
  selections: Gate4DSelection[];
}>;

export type MusicIdentityCanonicalRepresentativeSelectionShadowReport = Readonly<{
  gate: "4D";
  mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCalls: true;
    provider: "spotify";
    consumerInputBasis: typeof CONSUMER_INPUT_BASIS;
    identityAuthority: "GATE4B_SAFE_CANONICAL_COMPONENT";
    collisionAuthority: "GATE4C_CANONICAL_CONSUMER_COLLISION";
    representativePolicy: typeof REPRESENTATIVE_POLICY;
    sourceOrderAuthority: typeof SOURCE_ORDER_AUTHORITY;
    cacheOrderAuthority: typeof CACHE_ORDER_AUTHORITY;
    providerIdTieBreak: true;
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
    productiveRepresentativeSelection: false;
    likedTrackPreferenceRead: false;
    operationalCredentialRefreshMayWrite: true;
    operationalBackoffMayWrite: true;
  };
  baseline: {
    gate4cGeneratedAt: Date;
    gate4cSnapshotFingerprint: string;
    gate4dOrderedInputFingerprint: string;
    pairCount: number;
    componentCount: number;
    safeComponents: number;
    blockedComponents: number;
    targetComponentCollisions: number;
    distinctCollidingComponentsAcrossTargets: number;
    targetHypotheticalReduction: number;
  };
  orderingProof: {
    targetScopeOrderDeterministic: true;
    targetScopeOrderBasis: typeof SOURCE_ORDER_AUTHORITY;
    persistedCacheOrderDeterministic: true;
    persistedCacheOrderBasis: typeof CACHE_ORDER_AUTHORITY;
    postSelectionFingerprintMatched: true;
  };
  selection: {
    targetsEvaluated: number;
    targetsWithCollisions: number;
    collisionsReceived: number;
    collisionsSelectable: number;
    collisionsAbstained: number;
    distinctRepresentatives: number;
    hypotheticalDrops: number;
    gate4cExpectedHypotheticalDrops: number;
    reductionReconciled: true;
    selectionsDependingOnSourceOrder: number;
    selectionsDependingOnCachePosition: number;
    selectionsUsingProviderIdTieBreak: number;
    representativesAppearingInMultipleSources: number;
    targets: Gate4DTargetSelection[];
    samples: Gate4DSelection[];
  };
}>;

export type CanonicalRepresentativeSelectionAbstentionReason =
  | "GATE4C_ABSTAINED"
  | "GATE4C_COLLISION_DETAIL_INCOMPLETE"
  | "CONSUMER_ORDERING_NOT_REPRODUCIBLE"
  | "GATE4C_INPUT_MISMATCH"
  | "TARGET_OCCUPANCY_MISMATCH"
  | "CONSUMER_INPUT_CHANGED_DURING_SELECTION"
  | "GATE4C_REDUCTION_MISMATCH";

export type CanonicalRepresentativeSelectionAbstentionReport = Readonly<{
  gate: "4D";
  mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_ABSTAINED";
  userId: string;
  generatedAt: Date;
  authority: {
    providerCallsMayHaveOccurred: true;
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
    productiveRepresentativeSelection: false;
  };
  abstentionReason: CanonicalRepresentativeSelectionAbstentionReason;
  detail: string | null;
  gate4cMode: string;
  gate4cSnapshotFingerprint: string | null;
}>;

type Gate4DOrderedSource = {
  id: string;
  name: string | null;
  cacheUpdatedAt: Date;
  candidates: Array<{
    providerTrackId: string;
    uri: string;
    cachePosition: number;
  }>;
};

type Gate4DOrderedTarget = {
  id: string;
  name: string;
  effectiveSourceIds: string[];
};

type Gate4DOrderedInput = {
  valid: boolean;
  detail: string | null;
  sources: Gate4DOrderedSource[];
  targets: Gate4DOrderedTarget[];
  fingerprint: string;
};

type Gate4DSelectionAttempt =
  | { ok: true; selection: Gate4DSelection }
  | { ok: false; detail: string };

export function selectGate4DRepresentative(input: {
  targetPlaylistId: string;
  targetName: string;
  collision: Gate4CComponentCollisionSample;
  occurrences: readonly Gate4DOrderedOccurrence[];
}): Gate4DSelectionAttempt {
  const expectedMembers = [...input.collision.memberProviderTrackIdsPresent].sort();
  if (expectedMembers.length < 2) {
    return { ok: false, detail: `component ${input.collision.componentId} is not a collision` };
  }

  const allMembers = new Set(input.collision.allMemberProviderTrackIds);
  const currentMembers = [
    ...new Set(
      input.occurrences
        .filter((row) => allMembers.has(row.providerTrackId))
        .map((row) => row.providerTrackId),
    ),
  ].sort();
  if (!sameStrings(currentMembers, expectedMembers)) {
    return {
      ok: false,
      detail: `component ${input.collision.componentId} occupancy changed: expected=${expectedMembers.join(",")} current=${currentMembers.join(",")}`,
    };
  }

  const memberFirstOccurrences: Gate4DSelection["memberFirstOccurrences"] = [];
  for (const providerTrackId of expectedMembers) {
    const rows = input.occurrences
      .filter((row) => row.providerTrackId === providerTrackId)
      .sort(compareOccurrence);
    const firstOccurrence = rows[0];
    if (!firstOccurrence) {
      return {
        ok: false,
        detail: `component ${input.collision.componentId} member ${providerTrackId} has no ordered occurrence`,
      };
    }
    memberFirstOccurrences.push({
      providerTrackId,
      firstOccurrence,
      sourcePlaylistIds: [...new Set(rows.map((row) => row.sourcePlaylistId))].sort(),
    });
  }

  memberFirstOccurrences.sort(
    (a, b) =>
      compareOccurrence(a.firstOccurrence, b.firstOccurrence) ||
      a.providerTrackId.localeCompare(b.providerTrackId),
  );
  const winner = memberFirstOccurrences[0]!;
  const runnerUp = memberFirstOccurrences[1]!;
  const decisiveCriterion = decisiveCriterionFor(
    winner.firstOccurrence,
    runnerUp.firstOccurrence,
  );
  const droppedProviderTrackIds = memberFirstOccurrences
    .slice(1)
    .map((row) => row.providerTrackId);

  return {
    ok: true,
    selection: {
      targetPlaylistId: input.targetPlaylistId,
      targetName: input.targetName,
      componentId: input.collision.componentId,
      policy: REPRESENTATIVE_POLICY,
      preferenceState: input.collision.preferenceState,
      containsExcludedPreference: input.collision.containsExcludedPreference,
      memberProviderTrackIdsPresent: expectedMembers,
      representativeProviderTrackId: winner.providerTrackId,
      droppedProviderTrackIds,
      representativeOccurrence: winner.firstOccurrence,
      memberFirstOccurrences,
      decisiveCriterion,
      reasonChain: [
        `policy=${REPRESENTATIVE_POLICY}`,
        `sourceOrder=${winner.firstOccurrence.sourceOrder}:${winner.firstOccurrence.sourcePlaylistId}`,
        `cachePosition=${winner.firstOccurrence.cachePosition}`,
        `providerTrackId=${winner.providerTrackId}`,
        `decisiveCriterion=${decisiveCriterion}`,
      ],
      representativeAppearsInMultipleSources: winner.sourcePlaylistIds.length > 1,
      hypotheticalDrops: droppedProviderTrackIds.length,
      decision: "WOULD_KEEP_DROP",
    },
  };
}

export async function runMusicIdentityCanonicalRepresentativeSelectionShadow(
  userIdInput: string,
  options: { gate4cRunner?: Gate4DGate4CRunner } = {},
): Promise<
  | MusicIdentityCanonicalRepresentativeSelectionShadowReport
  | CanonicalRepresentativeSelectionAbstentionReport
> {
  const userId = clean(userIdInput);
  if (!userId) throw new Error("userId is required");

  const gate4cRunner = options.gate4cRunner ?? runMusicIdentityCanonicalConsumerDedupeShadow;
  const gate4c = await gate4cRunner(userId);
  if (gate4c.mode !== "SHADOW_CANONICAL_CONSUMER_DEDUPE_READ_ONLY") {
    return abstain(
      userId,
      "GATE4C_ABSTAINED",
      gate4c.mode,
      gate4c.baseline.snapshotFingerprint,
      gate4c.abstentionReason,
    );
  }

  const gate4cReport: MusicIdentityCanonicalConsumerDedupeShadowReport = gate4c;
  for (const target of gate4cReport.comparison.targets) {
    if (target.collisionSamples.length !== target.collisionComponents) {
      return abstain(
        userId,
        "GATE4C_COLLISION_DETAIL_INCOMPLETE",
        gate4cReport.mode,
        gate4cReport.baseline.snapshotFingerprint,
        `target ${target.targetPlaylistId}: collisionComponents=${target.collisionComponents}, samples=${target.collisionSamples.length}`,
      );
    }
  }

  const input = await collectGate4DOrderedInput(userId);
  if (!input.valid) {
    return abstain(
      userId,
      "CONSUMER_ORDERING_NOT_REPRODUCIBLE",
      gate4cReport.mode,
      gate4cReport.baseline.snapshotFingerprint,
      input.detail,
    );
  }
  const mismatch = compareGate4CInput(gate4cReport, input);
  if (mismatch) {
    return abstain(
      userId,
      "GATE4C_INPUT_MISMATCH",
      gate4cReport.mode,
      gate4cReport.baseline.snapshotFingerprint,
      mismatch,
    );
  }

  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const targetSelections: Gate4DTargetSelection[] = [];
  for (const target of gate4cReport.comparison.targets) {
    const occurrences: Gate4DOrderedOccurrence[] = target.effectiveSourceIds.flatMap(
      (sourceId, sourceOrder) => {
        const source = sourceById.get(sourceId);
        return (source?.candidates ?? []).map((candidate) => ({
          sourcePlaylistId: sourceId,
          sourceOrder,
          cachePosition: candidate.cachePosition,
          providerTrackId: candidate.providerTrackId,
          uri: candidate.uri,
        }));
      },
    );
    const selections: Gate4DSelection[] = [];
    for (const collision of target.collisionSamples) {
      const attempt = selectGate4DRepresentative({
        targetPlaylistId: target.targetPlaylistId,
        targetName: target.targetName,
        collision,
        occurrences,
      });
      if (!attempt.ok) {
        return abstain(
          userId,
          "TARGET_OCCUPANCY_MISMATCH",
          gate4cReport.mode,
          gate4cReport.baseline.snapshotFingerprint,
          attempt.detail,
        );
      }
      selections.push(attempt.selection);
    }
    const hypotheticalDrops = selections.reduce(
      (sum, selection) => sum + selection.hypotheticalDrops,
      0,
    );
    if (hypotheticalDrops !== target.hypotheticalReduction) {
      return abstain(
        userId,
        "GATE4C_REDUCTION_MISMATCH",
        gate4cReport.mode,
        gate4cReport.baseline.snapshotFingerprint,
        `target ${target.targetPlaylistId}: Gate4D=${hypotheticalDrops}, Gate4C=${target.hypotheticalReduction}`,
      );
    }
    targetSelections.push({
      targetPlaylistId: target.targetPlaylistId,
      targetName: target.targetName,
      effectiveSourceIds: [...target.effectiveSourceIds],
      gate4cCollisionComponents: target.collisionComponents,
      selectableCollisions: selections.length,
      abstainedCollisions: 0,
      hypotheticalDrops,
      distinctRepresentatives: new Set(
        selections.map((selection) => selection.representativeProviderTrackId),
      ).size,
      selectionsDependingOnSourceOrder: selections.filter(
        (selection) => selection.decisiveCriterion === "SOURCE_ORDER",
      ).length,
      selectionsDependingOnCachePosition: selections.filter(
        (selection) => selection.decisiveCriterion === "CACHE_POSITION",
      ).length,
      selectionsUsingProviderIdTieBreak: selections.filter(
        (selection) => selection.decisiveCriterion === "PROVIDER_TRACK_ID_TIE_BREAK",
      ).length,
      representativesAppearingInMultipleSources: selections.filter(
        (selection) => selection.representativeAppearsInMultipleSources,
      ).length,
      selections: selections.sort((a, b) => a.componentId.localeCompare(b.componentId)),
    });
  }
  targetSelections.sort((a, b) => a.targetPlaylistId.localeCompare(b.targetPlaylistId));

  const allSelections = targetSelections.flatMap((target) => target.selections);
  const hypotheticalDrops = allSelections.reduce(
    (sum, selection) => sum + selection.hypotheticalDrops,
    0,
  );
  if (hypotheticalDrops !== gate4cReport.comparison.targetHypotheticalReduction) {
    return abstain(
      userId,
      "GATE4C_REDUCTION_MISMATCH",
      gate4cReport.mode,
      gate4cReport.baseline.snapshotFingerprint,
      `global Gate4D=${hypotheticalDrops}, Gate4C=${gate4cReport.comparison.targetHypotheticalReduction}`,
    );
  }

  const postInput = await collectGate4DOrderedInput(userId);
  if (!postInput.valid || postInput.fingerprint !== input.fingerprint) {
    return abstain(
      userId,
      "CONSUMER_INPUT_CHANGED_DURING_SELECTION",
      gate4cReport.mode,
      gate4cReport.baseline.snapshotFingerprint,
      !postInput.valid
        ? postInput.detail
        : `before=${input.fingerprint} after=${postInput.fingerprint}`,
    );
  }

  return {
    gate: "4D",
    mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCalls: true,
      provider: "spotify",
      consumerInputBasis: CONSUMER_INPUT_BASIS,
      identityAuthority: "GATE4B_SAFE_CANONICAL_COMPONENT",
      collisionAuthority: "GATE4C_CANONICAL_CONSUMER_COLLISION",
      representativePolicy: REPRESENTATIVE_POLICY,
      sourceOrderAuthority: SOURCE_ORDER_AUTHORITY,
      cacheOrderAuthority: CACHE_ORDER_AUTHORITY,
      providerIdTieBreak: true,
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
      productiveRepresentativeSelection: false,
      likedTrackPreferenceRead: false,
      operationalCredentialRefreshMayWrite: true,
      operationalBackoffMayWrite: true,
    },
    baseline: {
      gate4cGeneratedAt: gate4cReport.generatedAt,
      gate4cSnapshotFingerprint: gate4cReport.baseline.snapshotFingerprint,
      gate4dOrderedInputFingerprint: input.fingerprint,
      pairCount: gate4cReport.baseline.pairCount,
      componentCount: gate4cReport.components.componentCount,
      safeComponents: gate4cReport.components.safeComponents,
      blockedComponents: gate4cReport.components.blockedComponents,
      targetComponentCollisions: gate4cReport.comparison.targetComponentCollisions,
      distinctCollidingComponentsAcrossTargets:
        gate4cReport.comparison.distinctCollidingComponentsAcrossTargets,
      targetHypotheticalReduction: gate4cReport.comparison.targetHypotheticalReduction,
    },
    orderingProof: {
      targetScopeOrderDeterministic: true,
      targetScopeOrderBasis: SOURCE_ORDER_AUTHORITY,
      persistedCacheOrderDeterministic: true,
      persistedCacheOrderBasis: CACHE_ORDER_AUTHORITY,
      postSelectionFingerprintMatched: true,
    },
    selection: {
      targetsEvaluated: targetSelections.length,
      targetsWithCollisions: targetSelections.filter(
        (target) => target.gate4cCollisionComponents > 0,
      ).length,
      collisionsReceived: gate4cReport.comparison.targetComponentCollisions,
      collisionsSelectable: allSelections.length,
      collisionsAbstained: 0,
      distinctRepresentatives: new Set(
        allSelections.map((selection) => selection.representativeProviderTrackId),
      ).size,
      hypotheticalDrops,
      gate4cExpectedHypotheticalDrops: gate4cReport.comparison.targetHypotheticalReduction,
      reductionReconciled: true,
      selectionsDependingOnSourceOrder: allSelections.filter(
        (selection) => selection.decisiveCriterion === "SOURCE_ORDER",
      ).length,
      selectionsDependingOnCachePosition: allSelections.filter(
        (selection) => selection.decisiveCriterion === "CACHE_POSITION",
      ).length,
      selectionsUsingProviderIdTieBreak: allSelections.filter(
        (selection) => selection.decisiveCriterion === "PROVIDER_TRACK_ID_TIE_BREAK",
      ).length,
      representativesAppearingInMultipleSources: allSelections.filter(
        (selection) => selection.representativeAppearsInMultipleSources,
      ).length,
      targets: targetSelections,
      samples: [...allSelections]
        .sort(
          (a, b) =>
            a.targetPlaylistId.localeCompare(b.targetPlaylistId) ||
            a.componentId.localeCompare(b.componentId),
        )
        .slice(0, SAMPLE_LIMIT),
    },
  };
}

async function collectGate4DOrderedInput(userId: string): Promise<Gate4DOrderedInput> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [user, sources, targets] = await Promise.all([
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
      ]);
      if (!user) throw new Error(`Sonoriza user not found: ${userId}`);

      const scopeSources = sources.map((source) => ({ id: source.id, enabled: source.enabled }));
      const orderedTargets: Gate4DOrderedTarget[] = [];
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
        if (!sameStrings(effectiveSourceIds, [...effectiveSourceIds].sort())) {
          return invalidInput("target source order is not lexicographically reproducible");
        }
        for (const sourceId of effectiveSourceIds) reachableSourceIds.add(sourceId);
        orderedTargets.push({ id: target.id, name: target.name, effectiveSourceIds });
      }
      orderedTargets.sort((a, b) => a.id.localeCompare(b.id));

      const orderedSources: Gate4DOrderedSource[] = [];
      for (const source of sources
        .filter((row) => row.kind === "MUSIC" && reachableSourceIds.has(row.id))
        .sort((a, b) => a.id.localeCompare(b.id))) {
        if (!source.cacheUpdatedAt) {
          return invalidInput(`source ${source.id} has no cacheUpdatedAt`);
        }
        const decoded = decodeMusicSourceCache(source.cachedCandidates);
        if (!decoded) {
          return invalidInput(`source ${source.id} is not FULL_VALID`);
        }
        orderedSources.push({
          id: source.id,
          name: source.name,
          cacheUpdatedAt: source.cacheUpdatedAt,
          candidates: decoded
            .map((candidate, cachePosition) => ({
              providerTrackId: clean(candidate.spotifyTrackId),
              uri: candidate.uri,
              cachePosition,
            }))
            .filter(
              (candidate): candidate is {
                providerTrackId: string;
                uri: string;
                cachePosition: number;
              } => Boolean(candidate.providerTrackId),
            ),
        });
      }

      const fingerprint = fingerprintOrderedInput(orderedTargets, orderedSources);
      return {
        valid: true,
        detail: null,
        sources: orderedSources,
        targets: orderedTargets,
        fingerprint,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

function compareGate4CInput(
  gate4c: MusicIdentityCanonicalConsumerDedupeShadowReport,
  input: Gate4DOrderedInput,
): string | null {
  const gate4cTargets = gate4c.comparison.targets.map((target) => ({
    id: target.targetPlaylistId,
    name: target.targetName,
    effectiveSourceIds: target.effectiveSourceIds,
  }));
  const currentTargets = input.targets.map((target) => ({
    id: target.id,
    name: target.name,
    effectiveSourceIds: target.effectiveSourceIds,
  }));
  if (JSON.stringify(gate4cTargets) !== JSON.stringify(currentTargets)) {
    return "target scope differs from Gate 4C snapshot";
  }

  const gate4cSources = gate4c.comparison.sources.map((source) => ({
    id: source.sourcePlaylistId,
    cacheStatus: source.cacheStatus,
    cacheUpdatedAt: source.cacheUpdatedAt,
  }));
  const currentSources = input.sources.map((source) => ({
    id: source.id,
    cacheStatus: "FULL_VALID",
    cacheUpdatedAt: source.cacheUpdatedAt.toISOString(),
  }));
  if (JSON.stringify(gate4cSources) !== JSON.stringify(currentSources)) {
    return "source cache identity/timestamps differ from Gate 4C snapshot";
  }
  return null;
}

function fingerprintOrderedInput(
  targets: readonly Gate4DOrderedTarget[],
  sources: readonly Gate4DOrderedSource[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targets: targets.map((target) => ({
          id: target.id,
          name: target.name,
          effectiveSourceIds: target.effectiveSourceIds,
        })),
        sources: sources.map((source) => ({
          id: source.id,
          cacheUpdatedAt: source.cacheUpdatedAt.toISOString(),
          candidates: source.candidates.map((candidate) => [
            candidate.cachePosition,
            candidate.providerTrackId,
            candidate.uri,
          ]),
        })),
      }),
    )
    .digest("hex");
}

function invalidInput(detail: string): Gate4DOrderedInput {
  return { valid: false, detail, sources: [], targets: [], fingerprint: "" };
}

function compareOccurrence(a: Gate4DOrderedOccurrence, b: Gate4DOrderedOccurrence): number {
  return (
    a.sourceOrder - b.sourceOrder ||
    a.cachePosition - b.cachePosition ||
    a.providerTrackId.localeCompare(b.providerTrackId)
  );
}

function decisiveCriterionFor(
  winner: Gate4DOrderedOccurrence,
  runnerUp: Gate4DOrderedOccurrence,
): Gate4DSelection["decisiveCriterion"] {
  if (winner.sourceOrder !== runnerUp.sourceOrder) return "SOURCE_ORDER";
  if (winner.cachePosition !== runnerUp.cachePosition) return "CACHE_POSITION";
  return "PROVIDER_TRACK_ID_TIE_BREAK";
}

function abstain(
  userId: string,
  abstentionReason: CanonicalRepresentativeSelectionAbstentionReason,
  gate4cMode: string,
  gate4cSnapshotFingerprint: string | null,
  detail: string | null,
): CanonicalRepresentativeSelectionAbstentionReport {
  return {
    gate: "4D",
    mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_ABSTAINED",
    userId,
    generatedAt: new Date(),
    authority: {
      providerCallsMayHaveOccurred: true,
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
      productiveRepresentativeSelection: false,
    },
    abstentionReason,
    detail,
    gate4cMode,
    gate4cSnapshotFingerprint,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
