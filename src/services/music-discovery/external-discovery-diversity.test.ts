import assert from "node:assert/strict";
import test from "node:test";

import type { ExternalDiscoverySimilarityProvider } from "./external-discovery";
import {
  decorateRootCandidates,
  expandLastFmExternalDiscoverySecondHop,
  mergeDiversifiedExternalDiscoveryCandidates,
  selectArtistDiverseTracks,
  selectDiversifiedArtistSeeds,
} from "./external-discovery-diversity";

test("Gate 5C rotates artist seed buckets before filling by affinity", () => {
  const selected = selectDiversifiedArtistSeeds({
    affinity: [
      { artistName: "Affinity A", affinity: 0.95 },
      { artistName: "Affinity B", affinity: 0.9 },
      { artistName: "Momentum A", affinity: 0.82 },
      { artistName: "Rediscovery A", affinity: 0.78 },
      { artistName: "Affinity C", affinity: 0.75 },
    ],
    priorityBuckets: [
      ["Affinity A", "Affinity B", "Affinity C"],
      ["Momentum A"],
      ["Rediscovery A"],
    ],
    limit: 4,
  });

  assert.deepEqual(
    selected.map((row) => row.artistName),
    ["Affinity A", "Momentum A", "Rediscovery A", "Affinity B"],
  );
});

test("Gate 5C prefers one track per artist before taking a second track", () => {
  const selected = selectArtistDiverseTracks(
    [
      { spotifyTrackId: "a1", artistName: "A", score: 99 },
      { spotifyTrackId: "a2", artistName: "A", score: 98 },
      { spotifyTrackId: "b1", artistName: "B", score: 90 },
      { spotifyTrackId: "c1", artistName: "C", score: 80 },
    ],
    3,
  );

  assert.deepEqual(
    selected.map((row) => row.spotifyTrackId),
    ["a1", "b1", "c1"],
  );
});

test("Gate 5C second hop compounds similarity and lowers source confidence", async () => {
  const root = decorateRootCandidates([
    {
      candidateKey: "artist:mbid:bridge",
      candidateType: "ARTIST",
      artistName: "Bridge Artist",
      trackName: null,
      artistMbid: "bridge",
      trackMbid: null,
      source: "LASTFM_SIMILAR_ARTIST",
      similarity: 0.8,
      sourceConfidence: 0.9,
      seedArtistName: "Root Artist",
      seedTrackName: null,
      seedArtistAffinity: 0.9,
      seedTrackAffinity: null,
    },
  ]);

  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      return [
        { name: "Root Artist", mbid: "root", match: 0.99, url: null },
        { name: "Bridge Artist", mbid: "bridge", match: 1, url: null },
        { name: "Fresh Artist", mbid: "fresh", match: 0.75, url: null },
      ];
    },
    async getSimilarTracks() {
      return [];
    },
  };

  const result = await expandLastFmExternalDiscoverySecondHop({
    provider,
    bridges: root,
    perSeed: 10,
  });

  assert.equal(result.status, "READY");
  assert.equal(result.providerCalls, 1);
  assert.equal(result.bridgeCount, 1);
  assert.equal(result.candidates.length, 1);
  const fresh = result.candidates[0]!;
  assert.equal(fresh.artistName, "Fresh Artist");
  assert.equal(fresh.acquisitionDepth, 2);
  assert.equal(fresh.rootSeedArtistName, "Root Artist");
  assert.equal(fresh.viaArtistName, "Bridge Artist");
  assert.ok(Math.abs(fresh.similarity - 0.6) < 1e-9);
  assert.ok(Math.abs(fresh.seedArtistAffinity - 0.72) < 1e-9);
  assert.equal(fresh.sourceConfidence, 0.72);
});

test("Gate 5C second hop isolates provider failures", async () => {
  const root = decorateRootCandidates([
    {
      candidateKey: "artist:name:bridge",
      candidateType: "ARTIST",
      artistName: "Bridge",
      trackName: null,
      artistMbid: null,
      trackMbid: null,
      source: "LASTFM_SIMILAR_ARTIST",
      similarity: 0.8,
      sourceConfidence: 0.9,
      seedArtistName: "Root",
      seedTrackName: null,
      seedArtistAffinity: 0.9,
      seedTrackAffinity: null,
    },
  ]);

  const provider: ExternalDiscoverySimilarityProvider = {
    async getSimilarArtists() {
      throw new Error("rate limited");
    },
    async getSimilarTracks() {
      return [];
    },
  };

  const result = await expandLastFmExternalDiscoverySecondHop({ provider, bridges: root });
  assert.equal(result.status, "ABSTAINED");
  assert.equal(result.abstentionReason, "PROVIDER_ERRORS");
  assert.equal(result.failures.length, 1);
});

test("Gate 5C merge keeps direct first-hop evidence over duplicate second-hop evidence", () => {
  const direct = decorateRootCandidates([
    {
      candidateKey: "artist:mbid:x",
      candidateType: "ARTIST",
      artistName: "X",
      trackName: null,
      artistMbid: "x",
      trackMbid: null,
      source: "LASTFM_SIMILAR_ARTIST",
      similarity: 0.7,
      sourceConfidence: 0.9,
      seedArtistName: "Root",
      seedTrackName: null,
      seedArtistAffinity: 0.9,
      seedTrackAffinity: null,
    },
  ]);
  const expanded = [
    {
      ...direct[0]!,
      acquisitionDepth: 2 as const,
      similarity: 0.95,
      sourceConfidence: 0.72,
      seedArtistName: "Bridge",
      rootSeedArtistName: "Root",
      viaArtistName: "Bridge",
    },
  ];

  const merged = mergeDiversifiedExternalDiscoveryCandidates({ root: direct, expanded });
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.acquisitionDepth, 1);
  assert.equal(merged[0]?.seedArtistName, "Root");
});
