import assert from "node:assert/strict";
import test from "node:test";

import type { AlbumOpportunityCandidate } from "./opportunity";
import {
  albumCoverageSummary,
  albumReasonLabel,
  albumRecommendationReasons,
  formatAlbumDuration,
  formatTrackDuration,
} from "./ui-presentation";

const candidate: AlbumOpportunityCandidate = {
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
    labelOnlyObservedTrackCount: 1,
    observedTrackCount: 3,
    canonicalCoverage: 0.2,
    analyticCoverage: 0.3,
    confidence: "MIXED_CANONICAL_AND_LABEL",
    matchedEventCount: 3,
    explicitSkipEventCount: 0,
    plays30d: 2,
    firstObservedAt: null,
    lastObservedAt: null,
  },
  components: {
    artistDeepening: 0.8,
    unexploredCoverage: 0.7,
    recentAlbumActivity: 0.5,
    adjustedExplicitSkipRate: 0.18,
    negativePenalty: 0,
  },
  reasons: [
    { code: "HIGH_ARTIST_DEEPENING", detail: "raw" },
    { code: "LOW_ALBUM_COVERAGE", detail: "raw" },
    { code: "RECENT_ALBUM_ACTIVITY", detail: "raw" },
  ],
};

test("album UI uses product language for canonical reason codes", () => {
  assert.equal(albumReasonLabel("HIGH_ARTIST_DEEPENING"), "Artista com alta afinidade");
  assert.deepEqual(albumRecommendationReasons(candidate, 2), [
    "Artista com alta afinidade",
    "Pouco explorado no seu histórico",
  ]);
});

test("coverage summary preserves observed count and analytic percent", () => {
  assert.equal(albumCoverageSummary(candidate), "3 de 10 faixas · 30% conhecido");
});

test("durations are compact for cards and tracklist", () => {
  assert.equal(formatAlbumDuration(3_600_000), "1h00");
  assert.equal(formatAlbumDuration(2_700_000), "45 min");
  assert.equal(formatTrackDuration(242_026), "4:02");
});
