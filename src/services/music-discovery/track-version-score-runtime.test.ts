import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import { TRACK_VERSION_SCORE_SHADOW_POLICY } from "./track-version-score-shadow";
import { TRACK_VERSION_SCORE_POLICY } from "./track-version-score-policy";
import { applyTrackVersionScoreToResolvedDiscovery } from "./track-version-score-runtime";

test("MUSIC-VERSION-01 Gate 4 promotes the validated Gate 3 multiplier without drift", () => {
  assert.equal(
    TRACK_VERSION_SCORE_POLICY.liveMultiplier,
    TRACK_VERSION_SCORE_SHADOW_POLICY.liveMultiplier,
  );
  assert.equal(TRACK_VERSION_SCORE_POLICY.liveMultiplier, 0.9);
});

test("MUSIC-VERSION-01 Gate 4 applies LIVE penalty to already-adjusted score and keeps raw score", () => {
  const source = discovery({
    key: "live",
    rawScore: 94.3,
    adjustedScore: 72.685,
    title: "Song - Live at Wembley",
    albumName: "Live at Wembley",
  });

  const result = applyTrackVersionScoreToResolvedDiscovery(source);

  assert.equal(result.rawScore, 94.3);
  assert.equal(result.adjustedScore, 65.417);
  assert.equal(result.trackVersionAdjustment?.scoreBefore, 72.685);
  assert.equal(result.trackVersionAdjustment?.scoreAfter, 65.417);
  assert.equal(result.trackVersionAdjustment?.classification, "LIVE");
  assert.match(result.resolutionReason, /VERSION_LIVE_X0\.90/);
});

test("MUSIC-VERSION-01 Gate 4 leaves studio score and resolver reason unchanged", () => {
  const source = discovery({
    key: "studio",
    rawScore: 93,
    adjustedScore: 70,
    title: "Dark Horse",
    albumName: "Axe To Fall",
  });

  const result = applyTrackVersionScoreToResolvedDiscovery(source);

  assert.equal(result.adjustedScore, 70);
  assert.equal(result.trackVersionAdjustment?.classification, "STUDIO_OR_STANDARD");
  assert.equal(result.resolutionReason, "EXACT_TRACK_ARTIST_MATCH");
});

test("MUSIC-VERSION-01 Gate 4 is idempotent and cannot double-penalize the same resolved candidate", () => {
  const once = applyTrackVersionScoreToResolvedDiscovery(
    discovery({
      key: "live",
      rawScore: 94.3,
      adjustedScore: 80,
      title: "Song - Live",
      albumName: "Live Album",
    }),
  );
  const twice = applyTrackVersionScoreToResolvedDiscovery(once);

  assert.equal(once.adjustedScore, 72);
  assert.equal(twice.adjustedScore, 72);
  assert.equal(twice.resolutionReason, once.resolutionReason);
  assert.equal(twice.trackVersionAdjustment, once.trackVersionAdjustment);
});

function discovery(input: {
  key: string;
  rawScore: number;
  adjustedScore: number;
  title: string;
  albumName: string;
}): Gate5FResolvedDiscoveryCandidate {
  const candidate: Candidate = {
    uri: `spotify:track:${input.key}`,
    type: "MUSIC",
    title: input.title,
    subtitle: "Artist",
    spotifyTrackId: input.key,
    primaryArtistId: `artist:${input.key}`,
    primaryArtistName: "Artist",
    albumId: `album:${input.key}`,
    albumName: input.albumName,
    durationMs: 180_000,
  };
  return {
    candidateKey: input.key,
    candidate,
    rawScore: input.rawScore,
    adjustedScore: input.adjustedScore,
    historyClass: "NEW_TRACK_KNOWN_ARTIST",
    pathLabel: "root → direct",
    resolutionReason: "EXACT_TRACK_ARTIST_MATCH",
    isrc: null,
  };
}
