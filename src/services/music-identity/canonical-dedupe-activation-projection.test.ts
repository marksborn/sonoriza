import assert from "node:assert/strict";
import test from "node:test";

import type { MusicIdentityCanonicalRepresentativeSelectionShadowReport } from "./canonical-representative-selection-shadow";
import {
  GATE4E0_POLICY,
  buildGate4E0ActivationProjection,
} from "./canonical-dedupe-activation-projection";

const TARGET = "target-avulsa";

function report(): MusicIdentityCanonicalRepresentativeSelectionShadowReport {
  const selectionBase = {
    targetPlaylistId: TARGET,
    targetName: "Avulsa",
    policy: GATE4E0_POLICY,
    preferenceState: "NO_EXPLICIT_TRACK_PREFERENCE" as const,
    containsExcludedPreference: false,
    representativeOccurrence: {
      sourcePlaylistId: "source-a",
      sourceOrder: 0,
      cachePosition: 10,
      providerTrackId: "track-a",
      uri: "spotify:track:track-a",
    },
    memberFirstOccurrences: [],
    decisiveCriterion: "CACHE_POSITION" as const,
    reasonChain: ["PERSISTED_SOURCE_CACHE_CANDIDATE_ARRAY_INDEX"],
    representativeAppearsInMultipleSources: false,
    hypotheticalDrops: 1,
    decision: "WOULD_KEEP_DROP" as const,
  };

  return {
    gate: "4D",
    mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY",
    userId: "user-pilot",
    generatedAt: new Date("2026-09-24T21:08:55.507Z"),
    authority: {
      providerCalls: true,
      provider: "spotify",
      consumerInputBasis: "TARGET_SOURCE_SCOPE_REACHABLE_PERSISTED_CACHE_PRE_SELECTION",
      identityAuthority: "GATE4B_SAFE_CANONICAL_COMPONENT",
      collisionAuthority: "GATE4C_CANONICAL_CONSUMER_COLLISION",
      representativePolicy: GATE4E0_POLICY,
      sourceOrderAuthority: "TARGET_SCOPE_EFFECTIVE_SOURCE_IDS_LEXICOGRAPHIC",
      cacheOrderAuthority: "PERSISTED_SOURCE_CACHE_CANDIDATE_ARRAY_INDEX",
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
      gate4cGeneratedAt: new Date("2026-09-24T21:08:55.227Z"),
      gate4cSnapshotFingerprint: "gate4c-fingerprint",
      gate4dOrderedInputFingerprint: "gate4d-fingerprint",
      pairCount: 121,
      componentCount: 61,
      safeComponents: 61,
      blockedComponents: 0,
      targetComponentCollisions: 2,
      distinctCollidingComponentsAcrossTargets: 2,
      targetHypotheticalReduction: 2,
    },
    orderingProof: {
      targetScopeOrderDeterministic: true,
      targetScopeOrderBasis: "TARGET_SCOPE_EFFECTIVE_SOURCE_IDS_LEXICOGRAPHIC",
      persistedCacheOrderDeterministic: true,
      persistedCacheOrderBasis: "PERSISTED_SOURCE_CACHE_CANDIDATE_ARRAY_INDEX",
      postSelectionFingerprintMatched: true,
    },
    selection: {
      targetsEvaluated: 1,
      targetsWithCollisions: 1,
      collisionsReceived: 2,
      collisionsSelectable: 2,
      collisionsAbstained: 0,
      distinctRepresentatives: 2,
      hypotheticalDrops: 2,
      gate4cExpectedHypotheticalDrops: 2,
      reductionReconciled: true,
      selectionsDependingOnSourceOrder: 0,
      selectionsDependingOnCachePosition: 2,
      selectionsUsingProviderIdTieBreak: 0,
      representativesAppearingInMultipleSources: 0,
      targets: [
        {
          targetPlaylistId: TARGET,
          targetName: "Avulsa",
          effectiveSourceIds: ["source-a", "source-b"],
          gate4cCollisionComponents: 2,
          selectableCollisions: 2,
          abstainedCollisions: 0,
          hypotheticalDrops: 2,
          distinctRepresentatives: 2,
          selectionsDependingOnSourceOrder: 0,
          selectionsDependingOnCachePosition: 2,
          selectionsUsingProviderIdTieBreak: 0,
          representativesAppearingInMultipleSources: 0,
          selections: [
            {
              ...selectionBase,
              componentId: "component-a",
              memberProviderTrackIdsPresent: ["track-a", "track-b"],
              representativeProviderTrackId: "track-a",
              droppedProviderTrackIds: ["track-b"],
            },
            {
              ...selectionBase,
              componentId: "component-b",
              memberProviderTrackIdsPresent: ["track-c", "track-d"],
              representativeProviderTrackId: "track-c",
              droppedProviderTrackIds: ["track-d"],
              representativeOccurrence: {
                ...selectionBase.representativeOccurrence,
                providerTrackId: "track-c",
                uri: "spotify:track:track-c",
              },
            },
          ],
        },
      ],
      samples: [],
    },
  };
}

test("builds a deterministic READY projection from Gate 4D", () => {
  const first = buildGate4E0ActivationProjection(report(), TARGET);
  const second = buildGate4E0ActivationProjection(report(), TARGET);

  assert.equal(first.mode, "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY");
  assert.equal(first.policy, GATE4E0_POLICY);
  assert.equal(first.componentCount, 2);
  assert.equal(first.hypotheticalDrops, 2);
  assert.deepEqual(first.effectiveSourceIds, ["source-a", "source-b"]);
  assert.equal(first.projectionFingerprint, second.projectionFingerprint);
  assert.equal(first.authority.plannerInfluence, false);
  assert.equal(first.authority.consumerActivation, false);
  assert.equal(first.authority.providerCallsInPlannerHotPath, false);
});

test("rejects Gate 4D abstention", () => {
  assert.throws(
    () =>
      buildGate4E0ActivationProjection(
        {
          gate: "4D",
          mode: "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_ABSTAINED",
          userId: "user-pilot",
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
          abstentionReason: "GATE4C_ABSTAINED",
          detail: null,
          gate4cMode: "ABSTAINED",
          gate4cSnapshotFingerprint: null,
        },
        TARGET,
      ),
    /not activatable/,
  );
});

test("rejects EXCLUDED preference even if the incoming selection is malformed", () => {
  const input = report();
  input.selection.targets[0]!.selections[0] = {
    ...input.selection.targets[0]!.selections[0]!,
    containsExcludedPreference: true,
  };
  assert.throws(
    () => buildGate4E0ActivationProjection(input, TARGET),
    /contains EXCLUDED preference/,
  );
});

test("rejects a representative outside the component", () => {
  const input = report();
  input.selection.targets[0]!.selections[0] = {
    ...input.selection.targets[0]!.selections[0]!,
    representativeProviderTrackId: "track-z",
  };
  assert.throws(
    () => buildGate4E0ActivationProjection(input, TARGET),
    /representative is not a member/,
  );
});
