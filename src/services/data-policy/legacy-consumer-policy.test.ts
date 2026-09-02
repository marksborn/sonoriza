import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_ANALYTICS_USES,
  HISTORY_RECOMMENDATION_USES,
  evaluateListeningEventForUses,
  spotifyCatalogRecommendationCapability,
  spotifyRecentlyPlayedPlannerCapability,
  spotifySavedTracksPlannerCapability,
  spotifySavedTracksRecommendationCapability,
  spotifySavedTracksShadowCapability,
  sqlAggregateListeningEventSourcesForUses,
} from "./legacy-consumer-policy";

test("MUSIC-01 Spotify Recently Played is not productively authorized", () => {
  const capability = spotifyRecentlyPlayedPlannerCapability();
  assert.equal(capability.allowed, false);
  assert.equal(capability.decisions.OPERATIONAL_PLANNING, "REVIEW_REQUIRED");
  assert.equal(capability.decisions.PLANNER_ELIGIBILITY, "REVIEW_REQUIRED");
});

test("Saved Tracks is blocked for shadow analytics, planner eligibility and recommendation", () => {
  const shadow = spotifySavedTracksShadowCapability();
  const planner = spotifySavedTracksPlannerCapability();
  const recommendation = spotifySavedTracksRecommendationCapability();
  assert.equal(shadow.allowed, false);
  assert.equal(shadow.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(planner.allowed, false);
  assert.equal(planner.decisions.OPERATIONAL_PLANNING, "REVIEW_REQUIRED");
  assert.equal(planner.decisions.PLANNER_ELIGIBILITY, "REVIEW_REQUIRED");
  assert.equal(recommendation.allowed, false);
  assert.equal(recommendation.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(recommendation.decisions.USER_PROFILING, "DENY");
  assert.equal(recommendation.decisions.RECOMMENDATION, "DENY");
});

test("Spotify catalog cannot drive recommendation under the current matrix", () => {
  const capability = spotifyCatalogRecommendationCapability();
  assert.equal(capability.allowed, false);
  assert.equal(capability.decisions.RECOMMENDATION, "DENY");
});

test("mixed Last.fm + Spotify enrichment cannot launder into history recommendation", () => {
  const result = evaluateListeningEventForUses(
    {
      source: "LASTFM_SCROBBLE",
      metadata: { spotifyExtendedHistory: { msPlayed: 1234 } },
    },
    HISTORY_RECOMMENDATION_USES,
  );
  assert.deepEqual(result.lineage.origins, ["SPOTIFY", "LASTFM"]);
  assert.equal(result.allowed, false);
  assert.equal(result.decisions.BEHAVIORAL_ANALYTICS, "DENY");
  assert.equal(result.decisions.USER_PROFILING, "DENY");
  assert.equal(result.decisions.RECOMMENDATION, "DENY");
});

test("current history SQL aggregation has no lineage-safe source", () => {
  assert.deepEqual(
    sqlAggregateListeningEventSourcesForUses(HISTORY_ANALYTICS_USES),
    [],
  );
  assert.deepEqual(
    sqlAggregateListeningEventSourcesForUses(HISTORY_RECOMMENDATION_USES),
    [],
  );
});
