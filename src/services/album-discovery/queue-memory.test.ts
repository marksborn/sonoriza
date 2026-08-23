import assert from "node:assert/strict";
import test from "node:test";

import type { AlbumOpportunityCandidate } from "./opportunity";
import { isPersistentlyQueued, suppressQueuedAlbumOpportunities } from "./queue-memory";

const baseCandidate: AlbumOpportunityCandidate = {
  spotifyAlbumId: "album1",
  albumName: "Album One",
  releaseDate: "2026-01-01",
  artistName: "Artist",
  artistDeepeningScore: 80,
  score: 75,
  eligible: true,
  memoryState: null,
  coverage: {
    policyVersion: "album-gate1-profile-readonly-v1",
    spotifyAlbumId: "album1",
    albumName: "Album One",
    releaseDate: "2026-01-01",
    catalogTrackCount: 10,
    eligibleTrackCount: 10,
    unavailableTrackCount: 0,
    canonicalObservedTrackCount: 2,
    labelOnlyObservedTrackCount: 0,
    observedTrackCount: 2,
    canonicalCoverage: 0.2,
    analyticCoverage: 0.2,
    confidence: "CANONICAL_ONLY",
    matchedEventCount: 2,
    explicitSkipEventCount: 0,
    plays30d: 0,
    firstObservedAt: null,
    lastObservedAt: null,
  },
  components: {
    artistDeepening: 0.8,
    unexploredCoverage: 0.8,
    recentAlbumActivity: 0,
    adjustedExplicitSkipRate: 0.18,
    negativePenalty: 0,
  },
  reasons: [],
};

test("QUEUED memory is authoritative for direct writer guard", () => {
  assert.equal(isPersistentlyQueued({ state: "QUEUED" }), true);
  assert.equal(isPersistentlyQueued({ state: "COMPLETED" }), false);
  assert.equal(isPersistentlyQueued(null), false);
});

test("QUEUED exact edition is suppressed from ranking", () => {
  const result = suppressQueuedAlbumOpportunities([baseCandidate], [
    { spotifyAlbumId: "album1", state: "QUEUED", queuedAt: new Date("2026-08-23T12:00:00Z") },
  ]);
  assert.deepEqual(result.suppressedAlbumIds, ["album1"]);
  assert.equal(result.candidates[0]?.eligible, false);
  assert.equal(result.candidates[0]?.memoryState, "QUEUED");
  assert.equal(result.candidates[0]?.reasons.at(-1)?.code, "ALBUM_ALREADY_QUEUED");
});

test("other exact editions remain eligible", () => {
  const otherEdition = { ...baseCandidate, spotifyAlbumId: "album2" };
  const result = suppressQueuedAlbumOpportunities([otherEdition], [
    { spotifyAlbumId: "album1", state: "QUEUED", queuedAt: new Date() },
  ]);
  assert.equal(result.candidates[0]?.eligible, true);
  assert.equal(result.candidates[0]?.memoryState, null);
  assert.deepEqual(result.suppressedAlbumIds, []);
});

test("non-QUEUED lifecycle states do not suppress in Gate 5", () => {
  const result = suppressQueuedAlbumOpportunities([baseCandidate], [
    { spotifyAlbumId: "album1", state: "COMPLETED", queuedAt: new Date() },
  ]);
  assert.equal(result.candidates[0]?.eligible, true);
  assert.deepEqual(result.suppressedAlbumIds, []);
});
