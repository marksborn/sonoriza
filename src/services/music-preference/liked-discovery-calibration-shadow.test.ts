import assert from "node:assert/strict";
import test from "node:test";

import {
  LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY,
  type LikedDiscoveryExpansionShadowReport,
  type LikedExpansionResolvedCandidate,
} from "./liked-discovery-expansion-shadow";
import {
  buildLikedCalibratedDiscoveryTop,
  buildLikedDiscoveryCalibrationShadowReport,
  calibrateLikedExpansionScore,
  findNearDuplicateSeedNames,
  isNearDuplicateProjectName,
} from "./liked-discovery-calibration-shadow";
import type { LikedShadowRankedRecommendation } from "./liked-shadow-discovery";

const current: LikedShadowRankedRecommendation = {
  key: "current:raunchy",
  category: "DESCOBERTA",
  artistName: "Raunchy",
  trackName: "My Game",
  albumName: null,
  spotifyTrackId: "track-raunchy",
  score: 57.4,
  reasonCodes: [],
  provenance: "LASTFM_SIMILAR_ARTIST",
  playCount: null,
  plays30d: null,
  lastPlayedAt: null,
  seedArtistName: "Seed",
  seedTrackName: null,
  baselineRank: 1,
  shadowRank: 1,
  baselineScore: 57.4,
  shadowScore: 63.4,
  shadowRankingScore: 63.4,
  boost: 6,
  signalKind: "DIRECT_LIKE",
  explanation: "direct",
  directAffinity: { spotifyArtistId: "artist-raunchy", likedTrackCount: 1 },
  similarAffinity: null,
};

function expansion(
  artistName: string,
  trackName: string,
  score: number,
  seedArtistNames: string[],
  spotifyTrackId = `track-${artistName.toLowerCase().replace(/\s+/g, "-")}`,
): LikedExpansionResolvedCandidate {
  return {
    candidateKey: `candidate:${artistName}`,
    providerArtistName: artistName,
    candidateArtistMbid: null,
    artistName,
    normalizedArtistName: artistName.toLowerCase(),
    maxSimilarity: 1,
    supportingSeeds: seedArtistNames.length,
    seedArtistNames,
    dominantSeed: {
      spotifyArtistId: "seed-a",
      artistName: seedArtistNames[0] ?? "Seed A",
      likedTrackCount: 16,
      affinity: 1,
      similarity: 1,
    },
    scoreCard: {
      category: "DESCOBERTA",
      candidateKey: `candidate:${artistName}`,
      artistName,
      source: "LASTFM_SIMILAR_ARTIST",
      score,
      eligible: true,
      components: {
        similarity: 1,
        seedArtistAffinity: 1,
        seedTrackAffinity: 1,
        sourceConfidence: 0.9,
      },
      reasons: [],
    },
    spotifyArtistId: `artist-${artistName.toLowerCase().replace(/\s+/g, "-")}`,
    spotifyTrackId,
    trackName,
    albumName: null,
    resolutionReason: "EXACT_ARTIST_WITH_REPRESENTATIVE_TRACK",
  };
}

function expansionReport(overrides?: {
  attempted?: number;
  resolved?: number;
  ambiguous?: number;
  resolvedCandidates?: LikedExpansionResolvedCandidate[];
}): LikedDiscoveryExpansionShadowReport {
  const resolvedCandidates =
    overrides?.resolvedCandidates ??
    [
      expansion("Choldra", "Casulo", 98.3, ["Chipset Zero", "EDC", "Lekhaina"]),
      expansion("Marcelo Nova", "Pastor João", 97, ["Raul Seixas"]),
      expansion(
        "Marilyn Manson & The Spooky Kids",
        "Suicide Snowman",
        94.3,
        ["Marilyn Manson"],
      ),
      expansion("Better Than Ezra", "Desperately Wanting", 93, ["Collective Soul"]),
    ];
  return {
    generatedAt: new Date("2026-08-26T12:24:44.325Z"),
    policy: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY,
    safety: {
      shadowOnly: true,
      databaseWrites: false,
      plannerInfluence: false,
      spotifyWrites: false,
      expansionLastFmCalls: 0,
    },
    baseline: {
      externalStatus: "READY",
      providerFailures: 0,
      discoveryPoolSize: 1,
      top: [current],
    },
    likedOverlay: { top: [current] },
    graph: {
      directAffinityArtists: 932,
      activeSeedArtists: 932,
      activeSimilarityEdges: 9277,
      aggregateArtistNames: 3830,
      ambiguousSimilarityArtistNames: 0,
      excludedDirectArtistNames: 695,
      excludedAlreadyRepresentedArtistNames: 0,
      historyProbedArtistNames: 120,
      rejectedKnownHistoryArtistNames: 90,
      eligibleResolutionCandidates: 30,
      selectedResolutionCandidates: 20,
    },
    resolution: {
      attempted: overrides?.attempted ?? 16,
      resolved: overrides?.resolved ?? 8,
      ambiguous: overrides?.ambiguous ?? 8,
      notFound: 0,
      rejectedResolvedDirectArtists: 0,
      rejectedResolvedRepresentedArtists: 0,
      rejectedResolvedHistoricalArtists: 0,
      failures: [],
      spotifyCatalogCalls: 24,
      spotifyFailures: 0,
      spotifyRateLimits: 0,
      spotifyRetries: 0,
    },
    resolvedCandidates,
    expandedTop: [],
    changes: {
      entrantsVsBaseline: [],
      exitsVsBaseline: [],
      entrantsVsLikedOverlay: [],
      exitsVsLikedOverlay: [],
    },
  };
}

test("Gate 6B compresses external expansion scores toward the discovery floor", () => {
  assert.equal(calibrateLikedExpansionScore(55), 55);
  assert.equal(calibrateLikedExpansionScore(98.3), 74.485);
  assert.equal(calibrateLikedExpansionScore(100), 75.25);
  assert.equal(calibrateLikedExpansionScore(40), 55);
  assert.throws(() => calibrateLikedExpansionScore(Number.NaN));
});

test("Gate 6B caps calibrated top at one exploratory slot", () => {
  const top = buildLikedCalibratedDiscoveryTop({
    currentTop: [current],
    expansions: [
      expansion("Choldra", "Casulo", 98.3, ["Chipset Zero"]),
      expansion("Marcelo Nova", "Pastor João", 97, ["Raul Seixas"]),
    ],
    topN: 4,
    maxExploratorySlots: 1,
  });

  assert.equal(top.length, 2);
  assert.deepEqual(top.map((row) => row.artistName), ["Choldra", "Raunchy"]);
  assert.equal(top.filter((row) => row.source === "LIKED_EXPANSION").length, 1);
  assert.equal(top[0]?.calibratedScore, 74.485);
  assert.equal(top[1]?.calibratedScore, 63.4);
});

test("Gate 6B quarantines obvious seed-name project continuations", () => {
  const manson = expansion(
    "Marilyn Manson & The Spooky Kids",
    "Suicide Snowman",
    94.3,
    ["Marilyn Manson"],
  );
  const taylor = expansion(
    "Taylor Hawkins & The Coattail Riders",
    "Not Bad Luck",
    97,
    ["Foo Fighters"],
  );

  assert.equal(
    isNearDuplicateProjectName(
      "Marilyn Manson & The Spooky Kids",
      "Marilyn Manson",
    ),
    true,
  );
  assert.equal(
    isNearDuplicateProjectName(
      "Taylor Hawkins & The Coattail Riders",
      "Foo Fighters",
    ),
    false,
  );
  assert.deepEqual(findNearDuplicateSeedNames(manson), ["Marilyn Manson"]);
  assert.deepEqual(findNearDuplicateSeedNames(taylor), []);
});

test("Gate 6B production-shaped evidence becomes a conservative mixed shadow top", () => {
  const report = buildLikedDiscoveryCalibrationShadowReport(expansionReport());

  assert.equal(report.sourceExpansion.ambiguityRate, 0.5);
  assert.equal(report.nearDuplicates.quarantined, 1);
  assert.equal(report.nearDuplicates.rows[0]?.artistName, "Marilyn Manson & The Spooky Kids");
  assert.deepEqual(report.calibratedTop.map((row) => row.artistName), ["Choldra", "Raunchy"]);
  assert.equal(report.mix.exploratorySlots, 1);
  assert.equal(report.mix.currentSlots, 1);
  assert.equal(report.mix.exploratoryShare, 0.5);
  assert.equal(report.mix.capacityExploratoryShare, 0.25);
  assert.equal(report.readiness.status, "READY_FOR_CONTROLLED_PILOT");
  assert.deepEqual(report.changesVsLikedOverlay.entrants.map((row) => row.artistName), ["Choldra"]);
  assert.deepEqual(report.changesVsLikedOverlay.exits, []);
});

test("Gate 6B keeps shadow when ambiguity exceeds the pilot guard", () => {
  const report = buildLikedDiscoveryCalibrationShadowReport(
    expansionReport({ attempted: 16, resolved: 7, ambiguous: 9 }),
  );

  assert.equal(report.sourceExpansion.ambiguityRate, 0.563);
  assert.equal(report.readiness.status, "KEEP_SHADOW");
  assert.ok(report.readiness.reasons.some((reason) => reason.includes("Ambiguity rate")));
});
