import assert from "node:assert/strict";
import test from "node:test";

import { policyDecisionForLineage } from "./provenance";
import {
  music06LastFmPlannerCapability,
  MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL,
} from "./music06-lastfm-planner-capability";

test("Gate 5B keeps the global Last.fm policy REVIEW_REQUIRED", () => {
  const capability = music06LastFmPlannerCapability();

  assert.equal(
    policyDecisionForLineage(capability.lineage, "RECOMMENDATION"),
    "REVIEW_REQUIRED",
  );
  assert.equal(
    policyDecisionForLineage(capability.lineage, "PLANNER_ELIGIBILITY"),
    "REVIEW_REQUIRED",
  );
});

test("Gate 5B resolves only the reviewed bounded rerank capability", () => {
  const capability = music06LastFmPlannerCapability();

  assert.equal(MUSIC_06_LASTFM_PERSONAL_RERANK_APPROVAL.approved, true);
  assert.equal(capability.baselineRecommendationDecision, "REVIEW_REQUIRED");
  assert.equal(capability.boundedRerankDecision, "ALLOW");
  assert.equal(capability.boundedRerankAllowed, true);
});

test("Gate 5B does not approve inferred Last.fm eligibility changes", () => {
  const capability = music06LastFmPlannerCapability();

  assert.equal(capability.baselinePlannerEligibilityDecision, "REVIEW_REQUIRED");
  assert.equal(capability.plannerEligibilityDecision, "REVIEW_REQUIRED");
  assert.equal(capability.eligibilityChangeAllowed, false);
});
