import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type ExternalDiscoverySimilarityProvider,
} from "./external-discovery";

test("Gate 5A deduplicates candidates, ignores seed self-matches and keeps strongest evidence", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists({ artistName }) {
      if (artistName === "Broken Seed") throw new Error("provider unavailable");
      if (artistName === "Mudvayne") {
        return [
          { name: "Mudvayne", mbid: "self", match: 1, url: null },
          { name: "Sevendust", mbid: "seven", match: 0.81, url: null },
        ];
      }
      return [
        { name: "Sevendust", mbid: "seven", match: 0.93, url: null },
        { name: "Nonpoint", mbid: "nonpoint", match: 0.84, url: null },
      ];
    },
    async getSimilarTracks() {
      return [
        {
          name: "New Track",
          artistName: "New Artist",
          trackMbid: "new-track",
          artistMbid: "new-artist",
          match: 0.9,
          url: null,
        },
      ];
    },
  };

  const result = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [
      { artistName: "Mudvayne", affinity: 0.9 },
      { artistName: "Disturbed", affinity: 0.95 },
      { artistName: "Broken Seed", affinity: 0.8 },
    ],
    trackSeeds: [
      {
        artistName: "Disturbed",
        trackName: "Stricken",
        artistAffinity: 0.95,
        trackAffinity: 0.88,
      },
    ],
    perSeed: 10,
    maxCandidates: 20,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.providerCalls, 4);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.seedArtistName, "Broken Seed");
  assert.equal(result.candidates.some((row) => row.artistName === "Mudvayne"), false);

  const sevendust = result.candidates.find((row) => row.artistName === "Sevendust");
  assert.ok(sevendust);
  assert.equal(sevendust.similarity, 0.93);
  assert.equal(sevendust.seedArtistName, "Disturbed");
  assert.equal(
    result.candidates.filter((row) => row.artistName === "Sevendust").length,
    1,
  );
  assert.ok(result.candidates.some((row) => row.trackName === "New Track"));
});

test("Gate 5A abstains on provider failure instead of throwing into the generation path", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      throw new Error("Last.fm API error 29: Rate limit exceeded");
    },
    async getSimilarTracks() {
      throw new Error("Last.fm API error 11: Service Offline");
    },
  };

  const result = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [{ artistName: "Seed", affinity: 0.9 }],
    trackSeeds: [
      {
        artistName: "Seed",
        trackName: "Track",
        artistAffinity: 0.9,
        trackAffinity: 0.8,
      },
    ],
  });

  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.abstentionReason, "PROVIDER_ERRORS");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 2);
});

test("evaluation preserves provenance and conservatively rejects artists already present in history", async () => {
  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      return [
        { name: "Fresh Artist", mbid: "fresh", match: 0.94, url: null },
        { name: "Known Artist", mbid: "known", match: 0.97, url: null },
      ];
    },
    async getSimilarTracks() {
      return [];
    },
  };

  const acquired = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds: [{ artistName: "Strong Seed", affinity: 0.92 }],
    trackSeeds: [],
  });
  const evaluated = evaluateExternalDiscoveryCandidates({
    candidates: acquired.candidates,
    knownHistoricalPlayCount: (candidate) =>
      candidate.artistName === "Known Artist" ? 12 : 0,
  });

  const fresh = evaluated.evaluated.find((row) => row.artistName === "Fresh Artist");
  const known = evaluated.evaluated.find((row) => row.artistName === "Known Artist");
  assert.ok(fresh);
  assert.ok(known);
  assert.equal(fresh.scoreCard.eligible, true);
  assert.equal(fresh.scoreCard.source, "LASTFM_SIMILAR_ARTIST");
  assert.equal(known.scoreCard.eligible, false);
  assert.equal(known.scoreCard.score, 0);
  assert.ok(
    known.scoreCard.reasons.some((reason) => reason.code === "KNOWN_HISTORY_NOT_NEW"),
  );
});
