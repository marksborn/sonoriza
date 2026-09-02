import assert from "node:assert/strict";
import test from "node:test";

import { lineageFromOrigins } from "./provenance";
import {
  DISCOVERY_PROFILE_POLICY_USES,
  evaluateDiscoveryListeningEvent,
  evaluateDiscoveryProfileLineage,
  lineageForDiscoveryListeningEvent,
} from "./discovery-profile-policy";

test("Gate 5 profile requires analytics, profiling and recommendation capability", () => {
  assert.deepEqual(DISCOVERY_PROFILE_POLICY_USES, [
    "BEHAVIORAL_ANALYTICS",
    "USER_PROFILING",
    "RECOMMENDATION",
  ]);
});

test("Spotify listening history is denied before discovery aggregation", () => {
  const evaluation = evaluateDiscoveryListeningEvent({
    source: "SPOTIFY_RECENTLY_PLAYED",
    metadata: null,
  });

  assert.deepEqual(evaluation.lineage.origins, ["SPOTIFY"]);
  assert.equal(evaluation.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(evaluation.decisions.USER_PROFILING, "DENY");
  assert.equal(evaluation.decisions.RECOMMENDATION, "DENY");
  assert.equal(evaluation.allowed, false);
});

test("Last.fm remains quarantined while its capabilities require review", () => {
  const evaluation = evaluateDiscoveryListeningEvent({
    source: "LASTFM_SCROBBLE",
    metadata: null,
  });

  assert.deepEqual(evaluation.lineage.origins, ["LASTFM"]);
  assert.equal(evaluation.decisions.BEHAVIORAL_ANALYTICS, "REVIEW_REQUIRED");
  assert.equal(evaluation.decisions.USER_PROFILING, "REVIEW_REQUIRED");
  assert.equal(evaluation.decisions.RECOMMENDATION, "REVIEW_REQUIRED");
  assert.equal(evaluation.allowed, false);
});

test("user import is not silently promoted into a behavioral profile", () => {
  const evaluation = evaluateDiscoveryListeningEvent({
    source: "IMPORT",
    metadata: null,
  });

  assert.deepEqual(evaluation.lineage.origins, ["USER_IMPORT"]);
  assert.equal(evaluation.allowed, false);
});

test("Last.fm source enriched by Spotify preserves mixed lineage and cannot launder Spotify", () => {
  const lineage = lineageForDiscoveryListeningEvent({
    source: "LASTFM_SCROBBLE",
    metadata: {
      spotifyExtendedHistory: {
        msPlayed: 123_456,
      },
    },
  });
  const evaluation = evaluateDiscoveryProfileLineage(lineage);

  assert.deepEqual(lineage.origins, ["SPOTIFY", "LASTFM"]);
  assert.equal(evaluation.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(evaluation.decisions.USER_PROFILING, "DENY");
  assert.equal(evaluation.decisions.RECOMMENDATION, "DENY");
  assert.equal(evaluation.allowed, false);
});

test("projected Extended History presence preserves Spotify lineage without original JSON", () => {
  const lineage = lineageForDiscoveryListeningEvent({
    source: "LASTFM_SCROBBLE",
    spotifyExtendedHistoryPresent: true,
  });

  assert.deepEqual(lineage.origins, ["SPOTIFY", "LASTFM"]);
});

test("malformed Extended History marker still counts as Spotify provenance", () => {
  const lineage = lineageForDiscoveryListeningEvent({
    source: "LASTFM_SCROBBLE",
    metadata: { spotifyExtendedHistory: "malformed" },
  });

  assert.deepEqual(lineage.origins, ["SPOTIFY", "LASTFM"]);
});

test("unknown listening source fails closed", () => {
  const evaluation = evaluateDiscoveryListeningEvent({
    source: "FUTURE_UNCLASSIFIED_SOURCE",
    metadata: null,
  });

  assert.deepEqual(evaluation.lineage.origins, ["UNKNOWN"]);
  assert.equal(evaluation.allowed, false);
});

test("pure first-party lineage is eligible for non-AI discovery personalization", () => {
  const evaluation = evaluateDiscoveryProfileLineage(
    lineageFromOrigins(["FIRST_PARTY"]),
  );

  assert.deepEqual(evaluation.decisions, {
    BEHAVIORAL_ANALYTICS: "ALLOW",
    USER_PROFILING: "ALLOW",
    RECOMMENDATION: "ALLOW",
  });
  assert.equal(evaluation.allowed, true);
});
