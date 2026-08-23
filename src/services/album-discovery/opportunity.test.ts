import assert from "node:assert/strict";
import test from "node:test";

import type { AlbumCoverageFacts } from "./profile";
import { rankAlbumOpportunities, scoreAlbumOpportunity } from "./opportunity";

function coverage(overrides: Partial<AlbumCoverageFacts> = {}): AlbumCoverageFacts {
  return {
    policyVersion: "album-gate1-profile-readonly-v1",
    spotifyAlbumId: "album-1",
    albumName: "Album One",
    releaseDate: "2020-01-01",
    catalogTrackCount: 10,
    eligibleTrackCount: 10,
    unavailableTrackCount: 0,
    canonicalObservedTrackCount: 0,
    labelOnlyObservedTrackCount: 0,
    observedTrackCount: 0,
    canonicalCoverage: 0,
    analyticCoverage: 0,
    confidence: "NO_HISTORY",
    matchedEventCount: 0,
    explicitSkipEventCount: 0,
    plays30d: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    ...overrides,
  };
}

test("Gate 2 rewards unexplored albums for a strong artist", () => {
  const result = scoreAlbumOpportunity({
    artistName: "Chevelle",
    artistDeepeningScore: 71.3,
    coverage: coverage(),
  });

  assert.equal(result.score, 72.1);
  assert.equal(result.eligible, true);
  assert.ok(result.reasons.some((reason) => reason.code === "HIGH_ARTIST_DEEPENING"));
  assert.ok(result.reasons.some((reason) => reason.code === "NO_ALBUM_HISTORY"));
});

test("Gate 2 lets recent partial exploration compete with a totally unseen album", () => {
  const unseen = scoreAlbumOpportunity({
    artistName: "Chevelle",
    artistDeepeningScore: 71.3,
    coverage: coverage({ spotifyAlbumId: "unseen", albumName: "Unseen" }),
  });
  const recentPartial = scoreAlbumOpportunity({
    artistName: "Chevelle",
    artistDeepeningScore: 71.3,
    coverage: coverage({
      spotifyAlbumId: "recent",
      albumName: "Recent",
      canonicalObservedTrackCount: 3,
      observedTrackCount: 3,
      canonicalCoverage: 0.3,
      analyticCoverage: 0.3,
      confidence: "CANONICAL_ONLY",
      matchedEventCount: 4,
      explicitSkipEventCount: 0,
      plays30d: 4,
    }),
  });

  assert.ok(recentPartial.score > unseen.score);
  assert.ok(recentPartial.reasons.some((reason) => reason.code === "RECENT_ALBUM_ACTIVITY"));
});

test("Gate 2 does not let one skip dominate a tiny sample", () => {
  const result = scoreAlbumOpportunity({
    artistName: "Chevelle",
    artistDeepeningScore: 71.3,
    coverage: coverage({
      canonicalObservedTrackCount: 3,
      observedTrackCount: 3,
      canonicalCoverage: 0.3,
      analyticCoverage: 0.3,
      confidence: "CANONICAL_ONLY",
      matchedEventCount: 4,
      explicitSkipEventCount: 1,
      plays30d: 4,
    }),
  });

  assert.ok(result.components.adjustedExplicitSkipRate < 0.3);
  assert.ok(result.components.negativePenalty < 4);
  assert.ok(result.score > 68);
});

test("Gate 2 heavily deprioritizes a fully observed album even with recent activity", () => {
  const result = scoreAlbumOpportunity({
    artistName: "Chevelle",
    artistDeepeningScore: 71.3,
    coverage: coverage({
      canonicalObservedTrackCount: 10,
      observedTrackCount: 10,
      canonicalCoverage: 1,
      analyticCoverage: 1,
      confidence: "CANONICAL_ONLY",
      matchedEventCount: 100,
      explicitSkipEventCount: 10,
      plays30d: 3,
    }),
  });

  assert.ok(result.score < 50);
  assert.ok(result.reasons.some((reason) => reason.code === "ALBUM_FULLY_OBSERVED"));
});

test("Gate 2 keeps label-only evidence analytical rather than inventing canonical identity", () => {
  const result = scoreAlbumOpportunity({
    artistName: "Soilwork",
    artistDeepeningScore: 70.4,
    coverage: coverage({
      canonicalObservedTrackCount: 0,
      labelOnlyObservedTrackCount: 2,
      observedTrackCount: 2,
      canonicalCoverage: 0,
      analyticCoverage: 0.2,
      confidence: "LABEL_ONLY",
      matchedEventCount: 2,
    }),
  });

  assert.equal(result.coverage.canonicalObservedTrackCount, 0);
  assert.equal(result.coverage.labelOnlyObservedTrackCount, 2);
  assert.ok(result.reasons.some((reason) => reason.code === "LABEL_ONLY_COVERAGE_EVIDENCE"));
});

test("Gate 2 ranking is deterministic", () => {
  const a = scoreAlbumOpportunity({
    artistName: "Korn",
    artistDeepeningScore: 69.4,
    coverage: coverage({ spotifyAlbumId: "b", albumName: "Beta" }),
  });
  const b = scoreAlbumOpportunity({
    artistName: "Korn",
    artistDeepeningScore: 69.4,
    coverage: coverage({ spotifyAlbumId: "a", albumName: "Alpha" }),
  });

  assert.deepEqual(
    rankAlbumOpportunities([a, b]).map((candidate) => candidate.spotifyAlbumId),
    ["a", "b"],
  );
});
