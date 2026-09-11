import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from ".";
import type { EffectiveSharingPolicy } from "./target-sharing-shadow";

const candidate = (uri: string): Candidate => ({
  uri,
  type: "MUSIC",
  title: uri,
  durationMs: 180_000,
});

const makeTarget = (
  id: string,
  priority: number,
): RunTarget => ({
  targetPlaylistId: id,
  name: id,
  priority,
  rules: {
    targetDurationMs: 180_000,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
  },
});

function run(
  policies?: ReadonlyMap<string, EffectiveSharingPolicy>,
  priorities: [number, number] = [1, 2],
) {
  return planRun({
    pools: {
      music: [candidate("spotify:track:shared")],
      podcasts: [],
    },
    targets: [
      makeTarget("target-a", priorities[0]),
      makeTarget("target-b", priorities[1]),
    ],
    sharingPolicyByTargetId: policies,
  });
}

test("#204 Gate 4 comparison remains available after Gate 5 activation", () => {
  const baseline = run();
  const active = run(
    new Map([
      ["target-a", "SHAREABLE"],
      ["target-b", "SHAREABLE"],
    ]),
  );

  // Without an explicit sharing-policy map, backward-compatible legacy
  // exclusivity is still preserved.
  assert.deepEqual(
    baseline.targets.map((target) => target.result.items.length),
    [1, 0],
  );

  // Gate 5 makes the persisted effective policy authoritative.
  assert.deepEqual(
    active.targets.map((target) =>
      target.result.items.map((item) => item.uri),
    ),
    [
      ["spotify:track:shared"],
      ["spotify:track:shared"],
    ],
  );

  // Gate 4 evidence remains present only as a comparison/diagnostic.
  assert.equal(active.targetSharingShadow?.plannerInfluence, false);
  assert.equal(active.targetSharingRuntime?.plannerInfluence, true);
  assert.equal(active.targetSharingRuntime?.mode, "ACTIVE");
});

test("#204 Gate 4 reports legacy block that would be shareable only for two SHAREABLE targets", () => {
  const result = run(
    new Map([
      ["target-a", "SHAREABLE"],
      ["target-b", "SHAREABLE"],
    ]),
  );

  assert.equal(result.targetSharingShadow?.plannerInfluence, false);
  assert.equal(result.targetSharingShadow?.legacyReservedCandidateCount, 1);
  assert.equal(result.targetSharingShadow?.effectiveConflictCandidateCount, 0);
  assert.equal(result.targetSharingShadow?.wouldBeShareableCandidateCount, 1);

  const second = result.targetSharingShadow?.targets.find(
    (target) => target.targetPlaylistId === "target-b",
  );

  assert.deepEqual(second?.shareableTargetIds, ["target-a"]);
  assert.deepEqual(second?.conflictingTargetIds, []);
});

test("#204 Gate 4 keeps conflict when either side is EXCLUSIVE", () => {
  const result = run(
    new Map([
      ["target-a", "EXCLUSIVE"],
      ["target-b", "SHAREABLE"],
    ]),
  );

  assert.equal(result.targetSharingShadow?.legacyReservedCandidateCount, 1);
  assert.equal(result.targetSharingShadow?.effectiveConflictCandidateCount, 1);
  assert.equal(result.targetSharingShadow?.wouldBeShareableCandidateCount, 0);

  const second = result.targetSharingShadow?.targets.find(
    (target) => target.targetPlaylistId === "target-b",
  );

  assert.deepEqual(second?.conflictingTargetIds, ["target-a"]);
});

test("#204 Gate 4 aggregate policy classification is independent of planner priority", () => {
  const policies = new Map<string, EffectiveSharingPolicy>([
    ["target-a", "SHAREABLE"],
    ["target-b", "SHAREABLE"],
  ]);

  const normal = run(policies, [1, 2]);
  const reversed = run(policies, [2, 1]);

  assert.equal(
    normal.targetSharingShadow?.legacyReservedCandidateCount,
    reversed.targetSharingShadow?.legacyReservedCandidateCount,
  );
  assert.equal(
    normal.targetSharingShadow?.effectiveConflictCandidateCount,
    reversed.targetSharingShadow?.effectiveConflictCandidateCount,
  );
  assert.equal(
    normal.targetSharingShadow?.wouldBeShareableCandidateCount,
    reversed.targetSharingShadow?.wouldBeShareableCandidateCount,
  );
});

test("#204 Gate 4 absent shadow input preserves the old result shape", () => {
  const result = run();
  assert.equal(result.targetSharingShadow, undefined);
});
