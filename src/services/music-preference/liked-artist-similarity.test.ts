import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLikedArtistSimilarityPlan,
  normalizeLastFmSimilarArtists,
  selectLikedArtistSimilaritySeeds,
  type ActiveArtistAffinity,
  type ArtistSimilarityAcquisition,
  type ExistingArtistSimilarityEdge,
  type ExistingArtistSimilaritySeed,
} from "@/services/music-preference/liked-artist-similarity";

const NOW = new Date("2026-08-25T18:45:00.000Z");

function affinity(
  spotifyArtistId: string,
  likedTrackCount = 1,
  options: Partial<ActiveArtistAffinity> = {},
): ActiveArtistAffinity {
  return {
    spotifyArtistId,
    artistName: `Artist ${spotifyArtistId}`,
    likedTrackCount,
    active: true,
    ...options,
  };
}

function seed(
  sourceSpotifyArtistId: string,
  options: Partial<ExistingArtistSimilaritySeed> = {},
): ExistingArtistSimilaritySeed {
  return {
    id: `seed-${sourceSpotifyArtistId}`,
    sourceSpotifyArtistId,
    sourceArtistName: `Artist ${sourceSpotifyArtistId}`,
    active: true,
    lastFetchedAt: new Date("2026-08-01T00:00:00.000Z"),
    refreshAfter: new Date("2026-09-01T00:00:00.000Z"),
    candidateCount: 1,
    lastError: null,
    ...options,
  };
}

function edge(
  sourceSpotifyArtistId: string,
  candidateKey: string,
  options: Partial<ExistingArtistSimilarityEdge> = {},
): ExistingArtistSimilarityEdge {
  return {
    id: `edge-${sourceSpotifyArtistId}-${candidateKey}`,
    seedStateId: `seed-${sourceSpotifyArtistId}`,
    sourceSpotifyArtistId,
    sourceArtistName: `Artist ${sourceSpotifyArtistId}`,
    candidateKey,
    candidateArtistName: `Candidate ${candidateKey}`,
    candidateArtistMbid: null,
    candidateArtistUrl: null,
    similarity: 0.8,
    active: true,
    ...options,
  };
}

function success(
  sourceSpotifyArtistId: string,
  candidates: ArtistSimilarityAcquisition["candidates"],
  reason: ArtistSimilarityAcquisition["source"]["reason"] = "UNFETCHED",
): ArtistSimilarityAcquisition {
  return {
    source: {
      spotifyArtistId: sourceSpotifyArtistId,
      artistName: `Artist ${sourceSpotifyArtistId}`,
      likedTrackCount: 1,
      reason,
    },
    status: "SUCCESS",
    candidates,
    error: null,
  };
}

test("seed selection prefers unfetched sources, respects budget and skips fresh cache", () => {
  const result = selectLikedArtistSimilaritySeeds({
    affinities: [
      affinity("a", 1),
      affinity("b", 5),
      affinity("c", 3),
      affinity("d", 9, { artistName: null }),
    ],
    existingSeeds: [
      seed("a"),
      seed("c", { refreshAfter: new Date("2026-08-20T00:00:00.000Z") }),
    ],
    now: NOW,
    budget: 2,
  });

  assert.equal(result.activeAffinityCount, 4);
  assert.equal(result.sourcesWithoutName, 1);
  assert.equal(result.freshSourceCount, 1);
  assert.equal(result.staleSourceCount, 1);
  assert.equal(result.unfetchedSourceCount, 1);
  assert.deepEqual(
    result.selected.map((row) => [row.spotifyArtistId, row.reason]),
    [
      ["b", "UNFETCHED"],
      ["c", "STALE"],
    ],
  );
});

test("normalization removes self, deduplicates provider rows and keeps strongest match", () => {
  const rows = normalizeLastFmSimilarArtists("Radiohead", [
    { name: "Radiohead", mbid: "self", match: 1, url: null },
    { name: "Muse", mbid: "muse-mbid", match: 0.7, url: "https://last.fm/muse" },
    { name: "Muse", mbid: "muse-mbid", match: 0.9, url: "https://last.fm/muse" },
    { name: "  Portishead  ", mbid: null, match: 0.8, url: null },
  ]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.candidateKey), [
    "mbid:muse-mbid",
    "name:portishead",
  ]);
  assert.equal(rows[0]?.similarity, 0.9);
});

test("successful refresh creates, reactivates, updates and deactivates edges deterministically", () => {
  const plan = buildLikedArtistSimilarityPlan({
    affinities: [affinity("a")],
    existingSeeds: [
      seed("a", { refreshAfter: new Date("2026-08-20T00:00:00.000Z") }),
    ],
    existingEdges: [
      edge("a", "name:old"),
      edge("a", "name:return", { active: false, candidateArtistName: "Returned" }),
      edge("a", "name:update", { candidateArtistName: "Before", similarity: 0.4 }),
    ],
    acquisitions: [
      success(
        "a",
        [
          { candidateKey: "name:return", name: "Returned", mbid: null, url: null, similarity: 0.7 },
          { candidateKey: "name:update", name: "After", mbid: null, url: null, similarity: 0.8 },
          { candidateKey: "name:new", name: "New", mbid: null, url: null, similarity: 0.6 },
        ],
        "STALE",
      ),
    ],
    now: NOW,
    budget: 20,
  });

  assert.equal(plan.seedStatesToRefresh, 1);
  assert.equal(plan.edgesToCreate, 1);
  assert.equal(plan.edgesToReactivate, 1);
  assert.equal(plan.edgesToUpdate, 1);
  assert.equal(plan.edgesToDeactivate, 1);
  assert.deepEqual(plan.after, {
    activeSeeds: 1,
    activeEdges: 3,
    distinctCandidates: 3,
  });
});

test("provider failure preserves existing similarity evidence and schedules only a seed error update", () => {
  const acquisition: ArtistSimilarityAcquisition = {
    source: {
      spotifyArtistId: "a",
      artistName: "Artist a",
      likedTrackCount: 2,
      reason: "STALE",
    },
    status: "FAILURE",
    candidates: [],
    error: "provider unavailable",
  };
  const plan = buildLikedArtistSimilarityPlan({
    affinities: [affinity("a", 2)],
    existingSeeds: [
      seed("a", { refreshAfter: new Date("2026-08-20T00:00:00.000Z") }),
    ],
    existingEdges: [edge("a", "name:keep")],
    acquisitions: [acquisition],
    now: NOW,
    budget: 20,
  });

  assert.equal(plan.failedSources, 1);
  assert.equal(plan.failedSeedUpdates, 1);
  assert.equal(plan.edgesToDeactivate, 0);
  assert.deepEqual(plan.after, {
    activeSeeds: 1,
    activeEdges: 1,
    distinctCandidates: 1,
  });
});

test("losing explicit artist affinity deactivates its seed and edges without touching other sources", () => {
  const plan = buildLikedArtistSimilarityPlan({
    affinities: [
      affinity("a", 0, { active: false }),
      affinity("b", 2),
    ],
    existingSeeds: [seed("a"), seed("b")],
    existingEdges: [edge("a", "name:x"), edge("b", "name:y")],
    acquisitions: [],
    now: NOW,
    budget: 20,
  });

  assert.deepEqual(plan.inactiveSourceArtistIds, ["a"]);
  assert.equal(plan.edgesToDeactivate, 1);
  assert.deepEqual(plan.after, {
    activeSeeds: 1,
    activeEdges: 1,
    distinctCandidates: 1,
  });
});

test("same candidate from different affinity seeds remains two auditable edges but one batch candidate", () => {
  const common = {
    candidateKey: "mbid:common",
    name: "Common Artist",
    mbid: "common",
    url: null,
    similarity: 0.9,
  };
  const plan = buildLikedArtistSimilarityPlan({
    affinities: [affinity("a"), affinity("b")],
    existingSeeds: [],
    existingEdges: [],
    acquisitions: [success("a", [common]), success("b", [{ ...common, similarity: 0.8 }])],
    now: NOW,
    budget: 20,
  });

  assert.equal(plan.edgesToCreate, 2);
  assert.equal(plan.distinctCandidatesInBatch, 1);
  assert.equal(plan.topCandidates[0]?.supportingSeeds, 2);
  assert.equal(plan.topCandidates[0]?.maxSimilarity, 0.9);
});
