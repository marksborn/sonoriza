import assert from "node:assert/strict";
import test from "node:test";

import { planRun } from "@/services/playlist-planner/plan-run-music-identity";
import type { Candidate } from "@/services/playlist-planner/types";

import {
  createGate4E1RuntimeState,
  projectGate4E1Candidates,
  resolveGate4E1Mode,
  runWithGate4E1RuntimeState,
} from "./canonical-dedupe-runtime";

const USER = "user-pilot";
const TARGET = "target-avulsa";

function music(id: string, sourcePlaylistId = "source-a"): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    durationMs: 60_000,
    sourcePlaylistId,
  };
}

const component = {
  componentId: "component-a",
  memberProviderTrackIds: ["track-a", "track-b"],
  representativeProviderTrackId: "track-a",
  preferenceState: "NO_EXPLICIT_TRACK_PREFERENCE",
  preferenceCompatible: true,
  containsExcludedPreference: false,
} as const;

test("Gate 4E1 is OFF by default and an empty allowlist cannot activate it", () => {
  assert.deepEqual(
    resolveGate4E1Mode({ userId: USER }),
    {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "MODE_OFF",
      allowlistedTargetIds: new Set<string>(),
    },
  );
  assert.equal(
    resolveGate4E1Mode({
      requestedMode: "ACTIVE",
      userId: USER,
      allowlist: "",
      targetPlaylistIds: [TARGET],
    }).effectiveMode,
    "OFF",
  );
});

test("Gate 4E1 ACTIVE requires the exact user + target pair", () => {
  const wrongUser = resolveGate4E1Mode({
    requestedMode: "ACTIVE",
    userId: USER,
    allowlist: `other-user:${TARGET}`,
    targetPlaylistIds: [TARGET],
  });
  const wrongTarget = resolveGate4E1Mode({
    requestedMode: "ACTIVE",
    userId: USER,
    allowlist: `${USER}:other-target`,
    targetPlaylistIds: [TARGET],
  });
  const exact = resolveGate4E1Mode({
    requestedMode: "ACTIVE",
    userId: USER,
    allowlist: `${USER}:${TARGET}`,
    targetPlaylistIds: [TARGET],
  });

  assert.equal(wrongUser.effectiveMode, "OFF");
  assert.equal(wrongTarget.effectiveMode, "OFF");
  assert.equal(exact.effectiveMode, "ACTIVE");
  assert.deepEqual([...exact.allowlistedTargetIds], [TARGET]);
});

test("READY component keeps the persisted representative and preserves candidate order", () => {
  const projected = projectGate4E1Candidates({
    candidates: [music("legacy"), music("track-b"), music("track-a"), music("tail")],
    components: [component],
  });

  assert.deepEqual(
    projected.candidates.map((candidate) => candidate.spotifyTrackId),
    ["legacy", "track-a", "tail"],
  );
  assert.equal(projected.aliasesCollapsed, 1);
  assert.equal(projected.componentsApplied, 1);
  assert.deepEqual(projected.representativesKept, ["track-a"]);
  assert.deepEqual(projected.droppedAliases, ["track-b"]);
});

test("changed membership/cardinality fails closed to the exact legacy pool", () => {
  const threeMemberComponent = {
    ...component,
    memberProviderTrackIds: ["track-a", "track-b", "track-c"],
  };
  const incomplete = [music("track-a"), music("track-b"), music("legacy")];
  const duplicate = [music("track-a"), music("track-b"), music("track-b"), music("legacy")];

  const incompleteProjection = projectGate4E1Candidates({
    candidates: incomplete,
    components: [threeMemberComponent],
  });
  const duplicateProjection = projectGate4E1Candidates({
    candidates: duplicate,
    components: [component],
  });

  assert.deepEqual(incompleteProjection.candidates, incomplete);
  assert.deepEqual(duplicateProjection.candidates, duplicate);
  assert.equal(incompleteProjection.aliasesCollapsed, 0);
  assert.equal(duplicateProjection.aliasesCollapsed, 0);
  assert.equal(incompleteProjection.componentAbstentions.length, 1);
  assert.equal(duplicateProjection.componentAbstentions.length, 1);
});

test("preference drift or EXCLUDED prevents every drop in the component", () => {
  const candidates = [music("track-a"), music("track-b"), music("legacy")];
  const drift = projectGate4E1Candidates({
    candidates,
    components: [{ ...component, preferenceCompatible: false }],
  });
  const excluded = projectGate4E1Candidates({
    candidates,
    components: [{ ...component, containsExcludedPreference: true }],
  });

  assert.deepEqual(drift.candidates, candidates);
  assert.deepEqual(excluded.candidates, candidates);
  assert.equal(drift.aliasesCollapsed, 0);
  assert.equal(excluded.aliasesCollapsed, 0);
});

test("planner seam applies canonical dedupe before selection and captures legacy comparison", () => {
  const state = createGate4E1RuntimeState({
    userId: USER,
    mode: {
      requestedMode: "ACTIVE",
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
    },
    allowlistedTargetIds: new Set([TARGET]),
    targets: new Map([
      [
        TARGET,
        {
          targetPlaylistId: TARGET,
          status: "READY",
          reason: null,
          projectionId: "projection-1",
          projectionVersion: 1,
          projectionFingerprint: "fingerprint",
          components: [component],
        },
      ],
    ]),
    databaseReads: true,
  });

  const result = runWithGate4E1RuntimeState(state, () =>
    planRun({
      pools: {
        music: [music("track-b"), music("track-a"), music("legacy")],
        podcasts: [],
      },
      targets: [
        {
          targetPlaylistId: TARGET,
          name: "Avulsa",
          priority: 0,
          rules: {
            targetDurationMs: 180_000,
            compositionMode: "PROPORTION",
            podcastPercent: 0,
            sequencePattern: ["MUSIC"],
            maxEpisodesPerProgram: 1,
          },
        },
      ],
      sourceIdsByTargetId: new Map([[TARGET, new Set(["source-a"])]]),
    }),
  );

  const plannedIds = result.targets[0]!.result.items.map(
    (candidate) => candidate.spotifyTrackId,
  );
  assert.deepEqual(plannedIds, ["track-a", "legacy"]);

  const evidence = state.evidenceByTargetId.get(TARGET);
  assert.equal(evidence?.plannerInfluence, true);
  assert.equal(evidence?.aliasesCollapsed, 1);
  assert.equal(evidence?.plannerComparison?.legacyItemCount, 3);
  assert.equal(evidence?.plannerComparison?.canonicalItemCount, 2);
  assert.equal(evidence?.plannerComparison?.orderChanged, true);
});
