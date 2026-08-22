import assert from "node:assert/strict";
import test from "node:test";

import {
  arbitrateExternalDiscoveryPaths,
  summarizeExternalDiscoveryPathConcentration,
  type ExternalDiscoveryPathCandidate,
} from "./external-discovery-arbitration";

test("Gate 5D caps a dominant second-hop path without force-filling the pool", () => {
  const candidates = [
    candidate("nonpoint", 75.2, "Sevendust", null, 1),
    candidate("devildriver", 69.3, "DevilDriver", null, 1),
    candidate("stick-figure", 66.8, "Incubus", "311", 2),
    candidate("dirty-heads", 59.9, "Incubus", "311", 2),
    candidate("sublime-with-rome", 59.4, "Incubus", "311", 2),
    candidate("rebelution", 58.7, "Incubus", "311", 2),
    candidate("iration", 58.3, "Incubus", "311", 2),
    candidate("ballyhoo", 55.1, "Incubus", "311", 2),
  ];

  const result = arbitrateExternalDiscoveryPaths({ candidates });

  assert.deepEqual(
    result.selected.map((row) => row.artistName),
    ["nonpoint", "devildriver", "stick-figure", "dirty-heads"],
  );
  assert.equal(result.selected.length, 4);
  assert.equal(
    result.selected.filter((row) => row.viaArtistName === "311").length,
    2,
  );
  assert.ok(result.rejected.some((row) => row.reason === "PATH_CAP"));
});

test("Gate 5D progressive path penalty can reject a repeated candidate below the score floor", () => {
  const candidates = [
    candidate("first", 60, "Root", "Bridge", 2),
    candidate("second", 58, "Root", "Bridge", 2),
  ];

  const result = arbitrateExternalDiscoveryPaths({
    candidates,
    maxPerPath: 3,
    maxPerRoot: 3,
    maxPerBridge: 3,
  });

  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0]?.artistName, "first");
  assert.equal(result.rejected[0]?.candidate.artistName, "second");
  assert.equal(result.rejected[0]?.reason, "ADJUSTED_SCORE_BELOW_MINIMUM");
  assert.equal(result.rejected[0]?.arbitrationAdjustedScore, 53.9);
});

test("Gate 5D root cap applies across different bridges from the same root", () => {
  const candidates = [
    candidate("a", 90, "Incubus", "Bridge A", 2),
    candidate("b", 89, "Incubus", "Bridge B", 2),
    candidate("c", 88, "Incubus", "Bridge C", 2),
    candidate("d", 87, "Incubus", "Bridge D", 2),
  ];

  const result = arbitrateExternalDiscoveryPaths({
    candidates,
    maxPerPath: 2,
    maxPerRoot: 2,
    maxPerBridge: 2,
    minimumAdjustedScore: 0,
  });

  assert.deepEqual(
    result.selected.map((row) => row.artistName),
    ["a", "b"],
  );
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((row) => row.reason === "ROOT_CAP"));
});

test("Gate 5D bridge cap does not apply to direct candidates", () => {
  const candidates = [
    candidate("a", 90, "Root", null, 1),
    candidate("b", 89, "Root", null, 1),
    candidate("c", 88, "Root", null, 1),
  ];

  const result = arbitrateExternalDiscoveryPaths({
    candidates,
    maxPerPath: 3,
    maxPerRoot: 3,
    maxPerBridge: 1,
    repeatPenaltyPerSelection: 0,
    minimumAdjustedScore: 0,
  });

  assert.equal(result.selected.length, 3);
});

test("Gate 5D concentration reports root, bridge and path dominance before and after arbitration", () => {
  const candidates = [
    candidate("direct-a", 80, "Root A", null, 1),
    candidate("bridge-a1", 70, "Root B", "Bridge X", 2),
    candidate("bridge-a2", 69, "Root B", "Bridge X", 2),
    candidate("bridge-a3", 68, "Root B", "Bridge X", 2),
  ];

  const before = summarizeExternalDiscoveryPathConcentration(candidates);
  const result = arbitrateExternalDiscoveryPaths({
    candidates,
    maxPerPath: 1,
    maxPerRoot: 2,
    maxPerBridge: 1,
    repeatPenaltyPerSelection: 0,
    minimumAdjustedScore: 0,
  });
  const after = summarizeExternalDiscoveryPathConcentration(result.selected);

  assert.equal(before.maxRootShare, 0.75);
  assert.equal(before.maxBridgeShare, 0.75);
  assert.equal(before.maxPathShare, 0.75);
  assert.equal(after.total, 2);
  assert.equal(after.maxRootShare, 0.5);
  assert.equal(after.maxBridgeShare, 0.5);
  assert.equal(after.maxPathShare, 0.5);
});

function candidate(
  artistName: string,
  score: number,
  rootSeedArtistName: string,
  viaArtistName: string | null,
  acquisitionDepth: 1 | 2,
): ExternalDiscoveryPathCandidate {
  const candidateKey = `artist:name:${artistName}`;
  return {
    candidateKey,
    candidateType: "ARTIST",
    artistName,
    trackName: null,
    artistMbid: null,
    trackMbid: null,
    source: "LASTFM_SIMILAR_ARTIST",
    similarity: 0.8,
    sourceConfidence: acquisitionDepth === 1 ? 0.9 : 0.72,
    seedArtistName: viaArtistName ?? rootSeedArtistName,
    seedTrackName: null,
    seedArtistAffinity: 0.85,
    seedTrackAffinity: null,
    knownHistoricalPlayCount: 0,
    artistHistoricalPlayCount: 0,
    trackHistoricalPlayCount: 0,
    trackHistoryMatch: "NOT_APPLICABLE",
    historyClass: "NEW_ARTIST",
    scoreCard: {
      category: "DESCOBERTA",
      candidateKey,
      artistName,
      source: "LASTFM_SIMILAR_ARTIST",
      score,
      eligible: true,
      components: {
        similarity: 0.8,
        seedArtistAffinity: 0.85,
        seedTrackAffinity: 0.85,
        sourceConfidence: acquisitionDepth === 1 ? 0.9 : 0.72,
      },
      reasons: [],
    },
    acquisitionDepth,
    rootSeedArtistName,
    viaArtistName,
  };
}
