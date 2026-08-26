import assert from "node:assert/strict";
import test from "node:test";

import type { LikedDirectAffinitySignal, LikedSimilaritySignal } from "./liked-shadow-discovery";
import {
  buildLikedExpandedDiscoveryTop,
  likedTrackCountAffinity,
  rankLikedExpansionAggregates,
  selectLikedExpansionResolutionCandidates,
  type LikedExpansionResolvedCandidate,
} from "./liked-discovery-expansion-shadow";

const direct: LikedDirectAffinitySignal[] = [
  {
    spotifyArtistId: "seed-a",
    artistName: "Seed A",
    likedTrackCount: 16,
  },
  {
    spotifyArtistId: "seed-b",
    artistName: "Seed B",
    likedTrackCount: 2,
  },
];

function edge(
  candidateKey: string,
  candidateArtistName: string,
  sourceSpotifyArtistId: string,
  sourceArtistName: string,
  similarity: number,
): LikedSimilaritySignal {
  return {
    candidateKey,
    candidateArtistName,
    sourceSpotifyArtistId,
    sourceArtistName,
    similarity,
  };
}

test("Gate 6A excludes direct artists, represented pool artists and ambiguous similar names", () => {
  const report = rankLikedExpansionAggregates({
    directAffinities: direct,
    representedArtistNames: new Set(["already represented"]),
    similarityEdges: [
      edge("candidate:new", "New Artist", "seed-a", "Seed A", 0.9),
      edge("candidate:direct", "Seed A", "seed-b", "Seed B", 1),
      edge(
        "candidate:represented",
        "Already Represented",
        "seed-a",
        "Seed A",
        1,
      ),
      edge("candidate:twin-1", "Twin", "seed-a", "Seed A", 0.95),
      edge("candidate:twin-2", " twin ", "seed-b", "Seed B", 0.9),
    ],
  });

  assert.deepEqual(report.rows.map((row) => row.artistName), ["New Artist"]);
  assert.equal(report.metrics.excludedDirectArtistNames, 1);
  assert.equal(report.metrics.excludedAlreadyRepresentedArtistNames, 1);
  assert.equal(report.metrics.ambiguousSimilarityArtistNames, 1);
});

test("multiple LIKED seeds aggregate without multiplying candidates and strongest seed drives existing discovery score", () => {
  const report = rankLikedExpansionAggregates({
    directAffinities: direct,
    similarityEdges: [
      edge("candidate:new", "New Artist", "seed-a", "Seed A", 0.8),
      edge("candidate:new", "New Artist", "seed-b", "Seed B", 1),
    ],
  });

  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.equal(row.supportingSeeds, 2);
  assert.equal(row.maxSimilarity, 1);
  assert.equal(row.dominantSeed.artistName, "Seed A");
  assert.equal(row.dominantSeed.affinity, 1);
  assert.equal(row.scoreCard.eligible, true);
  // Seed A wins the existing external-discovery path score using its own
  // similarity (0.8) and affinity (1.0); similarity=1.0 from Seed B is not stacked.
  assert.equal(row.scoreCard.score, 89);
});

test("known history is rejected before Spotify resolution and dominant-seed diversity is bounded", () => {
  const report = rankLikedExpansionAggregates({
    directAffinities: direct,
    similarityEdges: [
      edge("candidate:one", "One", "seed-a", "Seed A", 1),
      edge("candidate:two", "Two", "seed-a", "Seed A", 0.99),
      edge("candidate:three", "Three", "seed-a", "Seed A", 0.98),
      edge("candidate:four", "Four", "seed-b", "Seed B", 0.97),
      edge("candidate:known", "Known", "seed-b", "Seed B", 1),
    ],
  });
  const selected = selectLikedExpansionResolutionCandidates({
    rows: report.rows,
    historyByNormalizedArtistName: new Map([["known", 12]]),
    budget: 4,
    maxPerDominantSeed: 2,
  });

  assert.equal(selected.rejectedKnownHistoryArtistNames, 1);
  assert.equal(selected.selected.length, 3);
  assert.equal(
    selected.selected.filter((row) => row.dominantSeed.spotifyArtistId === "seed-a")
      .length,
    2,
  );
  assert.ok(!selected.selected.some((row) => row.artistName === "Known"));
});

test("expanded discovery can introduce resolved related artists without mutating current pool rows", () => {
  const currentTop = [
    {
      key: "d1",
      category: "DESCOBERTA" as const,
      artistName: "Current",
      trackName: "Current Track",
      albumName: null,
      spotifyTrackId: "track-current",
      score: 57,
      reasonCodes: [],
      provenance: "LASTFM_SIMILAR_ARTIST" as const,
      playCount: null,
      plays30d: null,
      lastPlayedAt: null,
      seedArtistName: "Seed",
      seedTrackName: null,
      baselineRank: 1,
      shadowRank: 1,
      baselineScore: 57,
      shadowScore: 63,
      shadowRankingScore: 63,
      boost: 6,
      signalKind: "DIRECT_LIKE" as const,
      explanation: "direct",
      directAffinity: { spotifyArtistId: "current", likedTrackCount: 1 },
      similarAffinity: null,
    },
  ];
  const expansion: LikedExpansionResolvedCandidate = {
    candidateKey: "candidate:new",
    artistName: "New Artist",
    normalizedArtistName: "new artist",
    maxSimilarity: 1,
    supportingSeeds: 2,
    seedArtistNames: ["Seed A", "Seed B"],
    dominantSeed: {
      spotifyArtistId: "seed-a",
      artistName: "Seed A",
      likedTrackCount: 16,
      affinity: 1,
      similarity: 0.9,
    },
    scoreCard: {
      category: "DESCOBERTA",
      candidateKey: "candidate:new",
      artistName: "New Artist",
      source: "LASTFM_SIMILAR_ARTIST",
      score: 99,
      eligible: true,
      components: {
        similarity: 1,
        seedArtistAffinity: 1,
        seedTrackAffinity: 1,
        sourceConfidence: 0.9,
      },
      reasons: [],
    },
    spotifyArtistId: "spotify-new",
    spotifyTrackId: "track-new",
    trackName: "New Track",
    albumName: "New Album",
    resolutionReason: "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK",
  };

  const top = buildLikedExpandedDiscoveryTop({
    currentTop,
    expansions: [expansion],
    topN: 2,
  });

  assert.deepEqual(top.map((row) => row.artistName), ["New Artist", "Current"]);
  assert.equal(top[0]?.source, "LIKED_EXPANSION");
  assert.equal(top[1]?.source, "CURRENT_POOL");
  assert.equal(currentTop[0]?.shadowRankingScore, 63);
});

test("Gate 6A LIKED affinity calibration is strong but bounded", () => {
  assert.equal(likedTrackCountAffinity(1), 0.65);
  assert.equal(likedTrackCountAffinity(2), 0.75);
  assert.equal(likedTrackCountAffinity(4), 0.8500000000000001);
  assert.equal(likedTrackCountAffinity(16), 1);
  assert.equal(likedTrackCountAffinity(64), 1);
  assert.throws(() => likedTrackCountAffinity(0));
});
