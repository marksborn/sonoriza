import assert from "node:assert/strict";
import test from "node:test";

import {
  isUseAllowed,
  lineageFromOrigins,
  lineageFromRootSource,
  mergeLineages,
  policyDecisionForLineage,
  policyDecisionForOrigin,
} from "./provenance";

test("lineage canonicalizes origins deterministically and removes duplicates", () => {
  assert.deepEqual(
    lineageFromOrigins(["SPOTIFY", "FIRST_PARTY", "SPOTIFY", "LASTFM"]),
    { origins: ["FIRST_PARTY", "SPOTIFY", "LASTFM"] },
  );
});

test("empty lineage fails closed as UNKNOWN", () => {
  assert.deepEqual(lineageFromOrigins([]), { origins: ["UNKNOWN"] });
  assert.equal(policyDecisionForLineage(lineageFromOrigins([]), "AI"), "DENY");
});

test("root source mapping preserves provider origin", () => {
  assert.deepEqual(lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED"), {
    origins: ["SPOTIFY"],
  });
  assert.deepEqual(lineageFromRootSource("USER_EXPLICIT"), {
    origins: ["FIRST_PARTY"],
  });
  assert.deepEqual(lineageFromRootSource("LASTFM_SCROBBLE"), {
    origins: ["LASTFM"],
  });
});

test("Spotify behavioral profiling, recommendation and AI are denied", () => {
  for (const use of [
    "BEHAVIORAL_ANALYTICS",
    "USER_PROFILING",
    "RECOMMENDATION",
    "AI",
  ] as const) {
    assert.equal(policyDecisionForOrigin("SPOTIFY", use), "DENY");
  }
});

test("Spotify operational planning and planner eligibility require explicit review", () => {
  assert.equal(
    policyDecisionForOrigin("SPOTIFY", "OPERATIONAL_PLANNING"),
    "REVIEW_REQUIRED",
  );
  assert.equal(
    policyDecisionForOrigin("SPOTIFY", "PLANNER_ELIGIBILITY"),
    "REVIEW_REQUIRED",
  );
});

test("Last.fm is not silently commercial-ready", () => {
  assert.equal(
    policyDecisionForOrigin("LASTFM", "BEHAVIORAL_ANALYTICS"),
    "REVIEW_REQUIRED",
  );
  assert.equal(policyDecisionForOrigin("LASTFM", "RECOMMENDATION"), "REVIEW_REQUIRED");
});

test("mixed lineage preserves Spotify restrictions", () => {
  const mixed = mergeLineages(
    lineageFromRootSource("USER_EXPLICIT"),
    lineageFromRootSource("SPOTIFY_RECENTLY_PLAYED"),
  );

  assert.deepEqual(mixed, { origins: ["FIRST_PARTY", "SPOTIFY"] });
  assert.equal(policyDecisionForLineage(mixed, "BEHAVIORAL_ANALYTICS"), "DENY");
  assert.equal(policyDecisionForLineage(mixed, "USER_PROFILING"), "DENY");
  assert.equal(policyDecisionForLineage(mixed, "RECOMMENDATION"), "DENY");
  assert.equal(policyDecisionForLineage(mixed, "AI"), "DENY");
});

test("most restrictive origin wins REVIEW_REQUIRED over ALLOW", () => {
  const mixed = mergeLineages(
    lineageFromRootSource("USER_EXPLICIT"),
    lineageFromRootSource("LASTFM_SCROBBLE"),
  );

  assert.equal(policyDecisionForLineage(mixed, "BEHAVIORAL_ANALYTICS"), "REVIEW_REQUIRED");
  assert.equal(isUseAllowed(mixed, "BEHAVIORAL_ANALYTICS"), false);
});

test("pure first-party data remains eligible for non-AI product uses", () => {
  const firstParty = lineageFromRootSource("SONORIZA_INTERACTION");

  assert.equal(policyDecisionForLineage(firstParty, "BEHAVIORAL_ANALYTICS"), "ALLOW");
  assert.equal(policyDecisionForLineage(firstParty, "USER_PROFILING"), "ALLOW");
  assert.equal(policyDecisionForLineage(firstParty, "RECOMMENDATION"), "ALLOW");
  assert.equal(policyDecisionForLineage(firstParty, "PLANNER_ELIGIBILITY"), "ALLOW");
  assert.equal(policyDecisionForLineage(firstParty, "AI"), "REVIEW_REQUIRED");
});
