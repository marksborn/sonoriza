import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLikedExpansionResolutionQualitySample,
  canMaterializeLikedExpansionResolvedCandidate,
  LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY,
} from "./liked-discovery-expansion-shadow";

test("Gate 6B quality sample keeps the full resolution budget after eight early successes", () => {
  const outcomes = [
    ...Array.from({ length: 8 }, () => "RESOLVED" as const),
    "AMBIGUOUS" as const,
    ...Array.from({ length: 11 }, () => "RESOLVED" as const),
    "OUTSIDE_BUDGET" as const,
  ];

  const sample = buildLikedExpansionResolutionQualitySample(
    outcomes,
    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.resolutionCandidateBudget,
  );

  assert.equal(sample.length, 20);
  assert.equal(sample[8], "AMBIGUOUS");
  assert.ok(!sample.includes("OUTSIDE_BUDGET"));
});

test("Gate 6A materialization stays capped at eight while the quality sample continues", () => {
  const target = LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.targetResolvedCandidates;
  const sample = Array.from({ length: 20 }, (_, index) => index + 1);
  const materialized: number[] = [];

  for (const candidate of sample) {
    if (
      canMaterializeLikedExpansionResolvedCandidate(
        materialized.length,
        target,
      )
    ) {
      materialized.push(candidate);
    }
  }

  assert.equal(sample.length, 20);
  assert.equal(materialized.length, 8);
  assert.deepEqual(materialized, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(
    canMaterializeLikedExpansionResolvedCandidate(8, target),
    false,
  );
  assert.equal(
    canMaterializeLikedExpansionResolvedCandidate(9, target),
    false,
  );
});

test("stable-sample helpers fail closed on invalid bounds", () => {
  assert.throws(() => buildLikedExpansionResolutionQualitySample([1], 0));
  assert.throws(() => canMaterializeLikedExpansionResolvedCandidate(-1, 8));
  assert.throws(() => canMaterializeLikedExpansionResolvedCandidate(0, 0));
});
