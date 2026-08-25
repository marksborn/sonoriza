import assert from "node:assert/strict";
import test from "node:test";

import type {
  ForYouCategory,
  ForYouRecommendation,
  ForYouReport,
} from "@/services/music-discovery/for-you-report";

import {
  buildLikedShadowDiscoveryComparison,
  directAffinityBoost,
  similarityAffinityBoost,
} from "./liked-shadow-discovery";

function recommendation(
  key: string,
  category: ForYouCategory,
  artistName: string,
  score: number,
): ForYouRecommendation {
  return {
    key,
    category,
    artistName,
    trackName: `Track ${key}`,
    albumName: null,
    spotifyTrackId: category === "DESCOBERTA" ? null : `spotify-${key}`,
    score,
    reasonCodes: [],
    provenance: category === "DESCOBERTA" ? "LASTFM_SIMILAR_TRACK" : "LISTENING_HISTORY",
    playCount: category === "DESCOBERTA" ? null : 3,
    plays30d: category === "DESCOBERTA" ? null : 0,
    lastPlayedAt: null,
    seedArtistName: category === "DESCOBERTA" ? "Seed" : null,
    seedTrackName: category === "DESCOBERTA" ? "Seed Track" : null,
  };
}

function baseline(input?: Partial<ForYouReport>): ForYouReport {
  return {
    generatedAt: new Date("2026-08-25T21:00:00.000Z"),
    coverage: {
      totalCanonicalEvents: 100,
      firstPlayedAt: new Date("2020-01-01T00:00:00.000Z"),
      lastPlayedAt: new Date("2026-08-25T20:00:00.000Z"),
    },
    cooldown: { enabled: true, complete: true },
    familiar: [],
    rediscovery: [],
    discovery: [],
    external: { status: "READY", providerFailures: 0, note: "ok" },
    ...input,
  };
}

test("direct LIKE is a strong bounded overlay across categories and does not stack similarity", () => {
  const report = buildLikedShadowDiscoveryComparison({
    baseline: baseline({
      familiar: [
        recommendation("f1", "FAMILIAR", "Other", 80),
        recommendation("f2", "FAMILIAR", "Direct Band", 72),
      ],
      discovery: [
        recommendation("d1", "DESCOBERTA", "Other Discovery", 80),
        recommendation("d2", "DESCOBERTA", "Direct Band", 73),
      ],
    }),
    directAffinities: [
      {
        spotifyArtistId: "direct-1",
        artistName: "Direct Band",
        likedTrackCount: 4,
      },
    ],
    similarityEdges: [
      {
        candidateKey: "mbid:direct-band",
        candidateArtistName: "Direct Band",
        sourceSpotifyArtistId: "seed-1",
        sourceArtistName: "Seed Band",
        similarity: 1,
      },
    ],
    activeSeedCount: 1,
    poolPerCategory: 4,
    topPerCategory: 2,
  });

  const familiarDirect = report.categories.familiar.shadow.find(
    (row) => row.artistName === "Direct Band",
  );
  const discoveryDirect = report.categories.discovery.shadow.find(
    (row) => row.artistName === "Direct Band",
  );

  assert.equal(familiarDirect?.signalKind, "DIRECT_LIKE");
  assert.equal(familiarDirect?.boost, 10);
  assert.equal(familiarDirect?.shadowScore, 82);
  assert.equal(familiarDirect?.shadowRank, 1);
  assert.equal(discoveryDirect?.signalKind, "DIRECT_LIKE");
  assert.equal(discoveryDirect?.boost, 10);
  assert.equal(discoveryDirect?.shadowScore, 83);
  assert.equal(discoveryDirect?.similarAffinity?.maxSimilarity, 1);
});

test("similar artist support is weaker and applies only to DESCOBERTA", () => {
  const similarityEdges = [
    {
      candidateKey: "mbid:similar-band",
      candidateArtistName: "Similar Band",
      sourceSpotifyArtistId: "seed-1",
      sourceArtistName: "Seed One",
      similarity: 1,
    },
    {
      candidateKey: "mbid:similar-band",
      candidateArtistName: "Similar Band",
      sourceSpotifyArtistId: "seed-2",
      sourceArtistName: "Seed Two",
      similarity: 0.9,
    },
  ];
  const report = buildLikedShadowDiscoveryComparison({
    baseline: baseline({
      familiar: [
        recommendation("f1", "FAMILIAR", "Similar Band", 70),
        recommendation("f2", "FAMILIAR", "Other", 69),
      ],
      discovery: [
        recommendation("d1", "DESCOBERTA", "Other", 80),
        recommendation("d2", "DESCOBERTA", "Similar Band", 76),
      ],
    }),
    directAffinities: [],
    similarityEdges,
    activeSeedCount: 2,
    poolPerCategory: 4,
    topPerCategory: 2,
  });

  const familiar = report.categories.familiar.shadow.find(
    (row) => row.artistName === "Similar Band",
  );
  const discovery = report.categories.discovery.shadow.find(
    (row) => row.artistName === "Similar Band",
  );

  assert.equal(familiar?.signalKind, "NONE");
  assert.equal(familiar?.boost, 0);
  assert.equal(discovery?.signalKind, "SIMILAR_EXPLORATORY");
  assert.equal(discovery?.boost, 4.5);
  assert.equal(discovery?.shadowScore, 80.5);
  assert.equal(discovery?.shadowRank, 1);
});

test("shadow comparison reports entrants, exits, movement and diversity without changing eligibility", () => {
  const report = buildLikedShadowDiscoveryComparison({
    baseline: baseline({
      discovery: [
        recommendation("d1", "DESCOBERTA", "A", 90),
        recommendation("d2", "DESCOBERTA", "B", 85),
        recommendation("d3", "DESCOBERTA", "C", 80),
        recommendation("d4", "DESCOBERTA", "D", 79),
        recommendation("d5", "DESCOBERTA", "E", 78),
      ],
    }),
    directAffinities: [
      { spotifyArtistId: "e", artistName: "E", likedTrackCount: 1 },
    ],
    similarityEdges: [],
    activeSeedCount: 0,
    poolPerCategory: 5,
    topPerCategory: 4,
  });

  const comparison = report.categories.discovery;
  assert.deepEqual(comparison.baseline.map((row) => row.artistName), ["A", "B", "C", "D"]);
  assert.deepEqual(comparison.shadow.map((row) => row.artistName), ["A", "B", "E", "C"]);
  assert.equal(comparison.changes.overlapCount, 3);
  assert.equal(comparison.changes.jaccard, 0.6);
  assert.deepEqual(comparison.changes.entrants.map((row) => row.artistName), ["E"]);
  assert.deepEqual(comparison.changes.exits.map((row) => row.artistName), ["D"]);
  assert.equal(comparison.changes.signalAffectedPool, 1);
  assert.equal(comparison.changes.signalAffectedTop, 1);
  assert.equal(comparison.diversity.shadow.uniqueArtists, 4);
  assert.equal(comparison.diversity.shadow.directAffinitySlots, 1);
});

test("ambiguous normalized artist identities fail closed", () => {
  const report = buildLikedShadowDiscoveryComparison({
    baseline: baseline({
      discovery: [recommendation("d1", "DESCOBERTA", "Twin", 70)],
    }),
    directAffinities: [
      { spotifyArtistId: "a", artistName: "Twin", likedTrackCount: 5 },
      { spotifyArtistId: "b", artistName: " twin ", likedTrackCount: 2 },
    ],
    similarityEdges: [
      {
        candidateKey: "mbid:twin-1",
        candidateArtistName: "Twin",
        sourceSpotifyArtistId: "seed-1",
        sourceArtistName: "Seed",
        similarity: 1,
      },
    ],
    activeSeedCount: 1,
    poolPerCategory: 1,
    topPerCategory: 1,
  });

  const row = report.categories.discovery.shadow[0]!;
  assert.equal(row.signalKind, "NONE");
  assert.equal(row.boost, 0);
  assert.equal(report.coverage.ambiguousDirectArtistNames, 1);
});

test("latent exploratory artists expose cached graph coverage without inventing tracks", () => {
  const report = buildLikedShadowDiscoveryComparison({
    baseline: baseline({
      discovery: [recommendation("d1", "DESCOBERTA", "Already Represented", 80)],
    }),
    directAffinities: [
      { spotifyArtistId: "direct", artistName: "Direct Artist", likedTrackCount: 1 },
    ],
    similarityEdges: [
      {
        candidateKey: "mbid:latent",
        candidateArtistName: "Latent Artist",
        sourceSpotifyArtistId: "seed-1",
        sourceArtistName: "Seed One",
        similarity: 0.95,
      },
      {
        candidateKey: "mbid:latent",
        candidateArtistName: "Latent Artist",
        sourceSpotifyArtistId: "seed-2",
        sourceArtistName: "Seed Two",
        similarity: 0.9,
      },
      {
        candidateKey: "mbid:represented",
        candidateArtistName: "Already Represented",
        sourceSpotifyArtistId: "seed-1",
        sourceArtistName: "Seed One",
        similarity: 1,
      },
      {
        candidateKey: "mbid:direct",
        candidateArtistName: "Direct Artist",
        sourceSpotifyArtistId: "seed-1",
        sourceArtistName: "Seed One",
        similarity: 1,
      },
    ],
    activeSeedCount: 2,
    poolPerCategory: 1,
    topPerCategory: 1,
  });

  assert.equal(report.latentExploratoryArtists.count, 1);
  assert.equal(report.latentExploratoryArtists.top[0]?.artistName, "Latent Artist");
  assert.equal(report.latentExploratoryArtists.top[0]?.supportingSeeds, 2);
  assert.equal(report.safety.likedSignalProviderCalls, 0);
  assert.equal(report.safety.databaseWrites, false);
});

test("boost calibration remains bounded", () => {
  assert.equal(directAffinityBoost(1), 6);
  assert.equal(directAffinityBoost(4), 10);
  assert.equal(directAffinityBoost(64), 12);
  assert.equal(similarityAffinityBoost(1, 1), 4);
  assert.equal(similarityAffinityBoost(1, 5), 6);
  assert.equal(similarityAffinityBoost(0.5, 1), 2);
});
