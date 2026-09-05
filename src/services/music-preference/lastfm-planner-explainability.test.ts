import assert from "node:assert/strict";
import test from "node:test";

import {
  MUSIC_06_EXPLAINABILITY_EVIDENCE_KIND,
  MUSIC_06_EXPLAINABILITY_EVIDENCE_METHOD,
  parseMusic06RunExplainability,
} from "./lastfm-planner-explainability";

function summary(overrides: Record<string, unknown> = {}) {
  return {
    music06PlannerInfluence: {
      policyVersion: "music-06-gate5b-runtime-v1",
      status: "READY",
      failure: null,
      policy: {
        enabled: true,
        reason: "ENABLED",
        approvalScope: "PERSONAL_NON_COMMERCIAL",
        boundedRerankAllowed: true,
        eligibilityChangeAllowed: false,
      },
      sourceRunCount: 8,
      selectedTargetCount: 3,
      observation: { scrobbleCount: 157 },
      projection: {
        assessedOccurrenceCount: 19,
        negativeOccurrenceCount: 5,
        duplicateOccurrenceCount: 0,
        conflictingOccurrenceCount: 0,
        unprojectableOccurrenceCount: 0,
      },
      application: {
        applicationCount: 2,
        groupEvaluationCount: 2,
        candidateOccurrenceCount: 177,
        influencedCandidateOccurrenceCount: 0,
        trackProjectionInfluenceCount: 0,
        artistProjectionInfluenceCount: 0,
        explicitPreferenceSuppressedCount: 0,
        maxObservedMusicRankShift: 0,
        applied: false,
        eligibilityChanged: false,
        applicationFailureCount: 0,
        lastFailure: null,
      },
      ...overrides,
    },
  };
}

test("Gate 6 ignores runs without MUSIC-06 summary", () => {
  assert.equal(parseMusic06RunExplainability({ status: "SUCCESS" }), null);
  assert.equal(parseMusic06RunExplainability(null), null);
});

test("Gate 6 exposes READY inference without claiming a rerank happened", () => {
  const result = parseMusic06RunExplainability(summary());
  assert.ok(result);
  assert.equal(result.outcome, "NO_RERANK");
  assert.equal(result.evidenceKind, MUSIC_06_EXPLAINABILITY_EVIDENCE_KIND);
  assert.equal(result.evidenceMethod, MUSIC_06_EXPLAINABILITY_EVIDENCE_METHOD);
  assert.equal(result.policyEnabled, true);
  assert.equal(result.boundedRerankAllowed, true);
  assert.equal(result.eligibilityChangeAllowed, false);
  assert.equal(result.assessedOccurrenceCount, 19);
  assert.equal(result.negativeOccurrenceCount, 5);
  assert.equal(result.applicationCount, 2);
  assert.equal(result.candidateOccurrenceCount, 177);
  assert.equal(result.applied, false);
  assert.equal(result.eligibilityChanged, false);
});

test("Gate 6 reports bounded rerank only when runtime says it applied", () => {
  const result = parseMusic06RunExplainability(
    summary({
      application: {
        applicationCount: 2,
        groupEvaluationCount: 2,
        candidateOccurrenceCount: 177,
        influencedCandidateOccurrenceCount: 3,
        trackProjectionInfluenceCount: 2,
        artistProjectionInfluenceCount: 1,
        explicitPreferenceSuppressedCount: 0,
        maxObservedMusicRankShift: 3,
        applied: true,
        eligibilityChanged: false,
        applicationFailureCount: 0,
        lastFailure: null,
      },
    }),
  );
  assert.ok(result);
  assert.equal(result.outcome, "RERANK_APPLIED");
  assert.equal(result.influencedCandidateOccurrenceCount, 3);
  assert.equal(result.maxObservedMusicRankShift, 3);
  assert.equal(result.eligibilityChanged, false);
});

test("Gate 6 distinguishes disabled and abstained runtime states", () => {
  const disabled = parseMusic06RunExplainability(
    summary({
      status: "DISABLED",
      policy: {
        enabled: false,
        reason: "MASTER_DISABLED",
        boundedRerankAllowed: true,
        eligibilityChangeAllowed: false,
      },
    }),
  );
  assert.ok(disabled);
  assert.equal(disabled.outcome, "DISABLED");

  const abstained = parseMusic06RunExplainability(
    summary({
      status: "PROVIDER_UNAVAILABLE",
      failure: "Last.fm timeout",
    }),
  );
  assert.ok(abstained);
  assert.equal(abstained.outcome, "ABSTAINED");
  assert.equal(abstained.preparationFailure, "Last.fm timeout");
});

test("Gate 6 surfaces fail-safe application failure without changing eligibility", () => {
  const result = parseMusic06RunExplainability(
    summary({
      application: {
        applicationCount: 2,
        groupEvaluationCount: 2,
        candidateOccurrenceCount: 177,
        influencedCandidateOccurrenceCount: 0,
        trackProjectionInfluenceCount: 0,
        artistProjectionInfluenceCount: 0,
        explicitPreferenceSuppressedCount: 0,
        maxObservedMusicRankShift: 0,
        applied: false,
        eligibilityChanged: false,
        applicationFailureCount: 1,
        lastFailure: "unexpected candidate shape",
      },
    }),
  );
  assert.ok(result);
  assert.equal(result.outcome, "FAILED_SAFE");
  assert.equal(result.lastFailure, "unexpected candidate shape");
  assert.equal(result.eligibilityChanged, false);
});
