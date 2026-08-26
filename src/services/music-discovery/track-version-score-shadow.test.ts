import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustScoreForTrackVersionShadow,
  buildTrackVersionScoreShadowReport,
  TRACK_VERSION_SCORE_SHADOW_POLICY,
} from "./track-version-score-shadow";

test("MUSIC-VERSION-01 Gate 3 leaves studio/standard score unchanged", () => {
  const result = adjustScoreForTrackVersionShadow({
    rawScore: 93,
    trackName: "Dark Horse",
    albumName: "Axe To Fall",
  });

  assert.equal(result.version.classification, "STUDIO_OR_STANDARD");
  assert.equal(result.multiplier, 1);
  assert.equal(result.adjustedScore, 93);
  assert.equal(result.scoreDelta, 0);
});

test("MUSIC-VERSION-01 Gate 3 penalizes explicit live recording without blocking it", () => {
  const result = adjustScoreForTrackVersionShadow({
    rawScore: 94.3,
    trackName: "Suicide Snowman - Live: Tampa Bay, FL 26 Apr '92",
    albumName: "Live as Hell 1992 + bonus track",
  });

  assert.equal(result.version.classification, "LIVE");
  assert.equal(result.multiplier, TRACK_VERSION_SCORE_SHADOW_POLICY.liveMultiplier);
  assert.equal(result.adjustedScore, 84.87);
  assert.equal(result.scoreDelta, -9.43);
  assert.ok(result.adjustedScore > 0);
});

test("MUSIC-VERSION-01 Gate 3 does not penalize lexical title Live Forever", () => {
  const result = adjustScoreForTrackVersionShadow({
    rawScore: 95,
    trackName: "Live Forever",
    albumName: "Definitely Maybe",
  });

  assert.equal(result.version.classification, "STUDIO_OR_STANDARD");
  assert.equal(result.adjustedScore, 95);
});

test("MUSIC-VERSION-01 Gate 3 reorders live below slightly weaker studio candidates in shadow", () => {
  const report = buildTrackVersionScoreShadowReport([
    {
      candidateKey: "live",
      artistName: "Live Artist",
      trackName: "Song - Live",
      albumName: "Live Album",
      rawScore: 94.3,
    },
    {
      candidateKey: "studio-a",
      artistName: "Studio A",
      trackName: "Studio Song A",
      albumName: "Album A",
      rawScore: 93,
    },
    {
      candidateKey: "studio-b",
      artistName: "Studio B",
      trackName: "Studio Song B",
      albumName: "Album B",
      rawScore: 92,
    },
  ]);

  assert.deepEqual(
    report.shadowOrder.map((row) => row.candidateKey),
    ["studio-a", "studio-b", "live"],
  );
  assert.equal(report.totals.liveCandidates, 1);
  assert.equal(report.totals.penalizedCandidates, 1);
  assert.equal(report.totals.changedRankCandidates, 3);
  assert.deepEqual(report.safety, {
    shadowOnly: true,
    plannerInfluence: false,
    databaseWrites: false,
    spotifyWrites: false,
  });
});

test("MUSIC-VERSION-01 Gate 3 preserves original order for equal adjusted scores", () => {
  const report = buildTrackVersionScoreShadowReport([
    {
      candidateKey: "first",
      artistName: "First",
      trackName: "Song One",
      albumName: "Album",
      rawScore: 90,
    },
    {
      candidateKey: "second",
      artistName: "Second",
      trackName: "Song Two",
      albumName: "Album",
      rawScore: 90,
    },
  ]);

  assert.deepEqual(
    report.shadowOrder.map((row) => row.candidateKey),
    ["first", "second"],
  );
});
