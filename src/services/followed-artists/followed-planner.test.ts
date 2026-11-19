import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner/types";

import type { FollowedCatalogCandidate } from "./followed-catalog";
import {
  followedCandidatesForPlanner,
  followedCeiling,
  readFollowedTargetReviews,
  resolveFollowedPlannerMode,
  spreadFollowedIntoPool,
} from "./followed-planner";

const MINUTE = 60_000;

function entry(id: string, artistId: string, lastFmRank: number | null, addedAt = "2026-11-19T00:00:00Z"): FollowedCatalogCandidate {
  return {
    spotifyTrackId: id, uri: `spotify:track:${id}`, name: `Song ${id}`, durationMs: 200_000,
    artistId, artistName: `Artist ${artistId}`, albumId: `al-${artistId}`, albumName: "Album",
    albumType: "album", releaseDate: "2024-01-01", imageUrl: null,
    reasons: ["FOLLOWED_ARTIST", "NOT_LIKED", "NO_KNOWN_PLAY", "LASTFM_RANK"], lastFmRank, addedAt,
  };
}

function poolOf(count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    uri: `spotify:track:p${index}`, type: "MUSIC" as const, title: `P${index}`, durationMs: 200_000,
  }));
}

test("#564 Gate D mode: OFF unless SHADOW or ACTIVE is explicit", () => {
  assert.equal(resolveFollowedPlannerMode(undefined), "OFF");
  assert.equal(resolveFollowedPlannerMode("garbage"), "OFF");
  assert.equal(resolveFollowedPlannerMode(" shadow "), "SHADOW");
  assert.equal(resolveFollowedPlannerMode("ACTIVE"), "ACTIVE");
});

test("#564 Gate D ceiling: intensity cap, never above 5% of music, minimum 1", () => {
  // 60 min all music ≈ 15 tracks → 5% = 0 → minimum 1.
  assert.equal(followedCeiling({ intensity: "EXPLORATORY", targetDurationMs: 60 * MINUTE, podcastPercent: 0 }), 1);
  // 240 min all music ≈ 60 tracks → 5% = 3.
  assert.equal(followedCeiling({ intensity: "EXPLORATORY", targetDurationMs: 240 * MINUTE, podcastPercent: 0 }), 3);
  assert.equal(followedCeiling({ intensity: "BALANCED", targetDurationMs: 240 * MINUTE, podcastPercent: 0 }), 2);
  assert.equal(followedCeiling({ intensity: "CONSERVATIVE", targetDurationMs: 600 * MINUTE, podcastPercent: 0 }), 1);
  // Podcast share shrinks the music estimate: 240 min at 50% ≈ 30 tracks → 5% = 1.
  assert.equal(followedCeiling({ intensity: "EXPLORATORY", targetDurationMs: 240 * MINUTE, podcastPercent: 50 }), 1);
});

test("#564 Gate D selection: Last.fm order, one per artist, 7-day spacing excluded", () => {
  const { candidates, spacingExcluded } = followedCandidatesForPlanner(
    [entry("b1", "b", 2), entry("a1", "a", 1), entry("a2", "a", 1), entry("c1", "c", null), entry("r1", "recent", 0)],
    new Set(["recent"]),
  );
  assert.deepEqual(candidates.map((candidate) => candidate.spotifyTrackId), ["a1", "b1", "c1"]);
  assert.equal(spacingExcluded, 1);
  assert.equal(candidates[0]!.primaryArtistId, "a");
  assert.equal(candidates[0]!.type, "MUSIC");
});

test("#564 Gate D spread: offset positions, ceiling, skips pool and Novidades URIs", () => {
  const followed = followedCandidatesForPlanner(
    [entry("x", "a", 1), entry("y", "b", 2), entry("z", "c", 3)],
    new Set(),
  ).candidates;
  const pool = poolOf(10);
  const { pool: spread, injected } = spreadFollowedIntoPool(pool, followed, 2, new Set(["spotify:track:x"]));
  assert.deepEqual(injected.map((candidate) => candidate.uri), ["spotify:track:y", "spotify:track:z"]);
  assert.equal(spread.length, 12);
  assert.equal(spread[3]!.uri, "spotify:track:y", "first at index 3, away from Novidades at index 1");
  assert.equal(spread.filter((candidate) => candidate.uri === "spotify:track:x").length, 0);

  const already = spreadFollowedIntoPool([...pool, followed[1]!], followed, 3);
  assert.equal(already.injected.some((candidate) => candidate.uri === "spotify:track:y"), false);
  assert.deepEqual(spreadFollowedIntoPool(pool, followed, 0).injected, []);
});

test("#564 Gate D review: SHADOW wording, empty catalog and policy block", () => {
  const reviews = readFollowedTargetReviews({
    targetDiscoveryRuntime: {
      evidence: {
        followedArtists: [
          { targetPlaylistId: "t1", mode: "SHADOW", status: "OK", injected: [{ title: "Song", artists: "Band" }] },
          { targetPlaylistId: "t2", mode: "SHADOW", status: "NO_CATALOG", injected: [] },
          { targetPlaylistId: "t3", mode: "ACTIVE", status: "POLICY_BLOCKED", injected: [] },
          { targetPlaylistId: "t4", mode: "ACTIVE", status: "OK", injected: [{ title: "Other" }] },
        ],
      },
    },
  });
  assert.equal(reviews.get("t1")!.label, "1 faixa(s) entrariam — em teste, ainda fora da playlist");
  assert.deepEqual(reviews.get("t1")!.titles, ["Song — Band"]);
  assert.match(reviews.get("t2")!.label, /catálogo vazio/);
  assert.match(reviews.get("t3")!.label, /política/);
  assert.equal(reviews.get("t4")!.label, "1 faixa(s) entraram como candidatas");
  assert.equal(readFollowedTargetReviews(null).size, 0);
});
