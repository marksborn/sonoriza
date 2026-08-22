import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";
import type { DiscoveryPlannerPoolEntry } from "./planner-bridge";
import {
  blendResolvedDiscoveryIntoPlannerPool,
  type Gate5FResolvedDiscoveryCandidate,
} from "./planner-discovery-gate5f";

test("Gate 5F keeps discovery under a 20% prefix ceiling", () => {
  const result = blendResolvedDiscoveryIntoPlannerPool({
    baseline: baseline(12),
    discoveries: [discovery("d1", 90), discovery("d2", 80)],
  });

  assert.deepEqual(result.evidence.discoveryPositions, [5, 10]);
  assert.equal(result.entries[4]?.category, "DESCOBERTA");
  assert.equal(result.entries[9]?.category, "DESCOBERTA");
  assert.ok(result.evidence.maxObservedPrefixShare <= 0.2);
});

test("Gate 5F never force-fills discovery when the baseline is too short", () => {
  const result = blendResolvedDiscoveryIntoPlannerPool({
    baseline: baseline(3),
    discoveries: [discovery("d1", 90)],
  });

  assert.equal(result.evidence.acceptedDiscoveryCount, 0);
  assert.equal(result.rejected[0]?.reason, "DISCOVERY_CEILING");
  assert.equal(result.entries.length, 3);
});

test("Gate 5F promotes an already-present resolved track instead of duplicating it", () => {
  const existing = candidate("same", "Existing", "artist-existing");
  const base = baseline(8);
  base.splice(2, 0, baselineEntry(existing, 77));

  const result = blendResolvedDiscoveryIntoPlannerPool({
    baseline: base,
    discoveries: [discovery("same", 95)],
  });

  assert.equal(result.evidence.promotedBaselineDuplicateCount, 1);
  assert.equal(
    result.entries.filter((entry) => entry.candidate.spotifyTrackId === "same").length,
    1,
  );
  assert.equal(
    result.entries.find((entry) => entry.candidate.spotifyTrackId === "same")?.category,
    "DESCOBERTA",
  );
});

test("Gate 5F sorts resolved discoveries deterministically by adjusted score", () => {
  const result = blendResolvedDiscoveryIntoPlannerPool({
    baseline: baseline(12),
    discoveries: [discovery("low", 70), discovery("high", 90)],
  });

  const discoveries = result.entries.filter((entry) => entry.category === "DESCOBERTA");
  assert.equal(discoveries[0]?.candidate.spotifyTrackId, "high");
  assert.equal(discoveries[1]?.candidate.spotifyTrackId, "low");
});

test("Gate 5F rejects unusable discovery identities before planner exposure", () => {
  const invalid = discovery("invalid", 90);
  invalid.candidate.durationMs = 0;

  const result = blendResolvedDiscoveryIntoPlannerPool({
    baseline: baseline(8),
    discoveries: [invalid],
  });

  assert.equal(result.evidence.acceptedDiscoveryCount, 0);
  assert.equal(result.rejected[0]?.reason, "INVALID_DISCOVERY_CANDIDATE");
});

function baseline(count: number): DiscoveryPlannerPoolEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `base-${index + 1}`;
    return baselineEntry(candidate(id, `Base ${index + 1}`, `artist-${index + 1}`), 100 - index);
  });
}

function baselineEntry(candidateValue: Candidate, score: number): DiscoveryPlannerPoolEntry {
  return {
    candidate: candidateValue,
    category: "FAMILIAR",
    score,
    matchSource: "SPOTIFY_TRACK_ID",
    matchedScoreTrackId: candidateValue.spotifyTrackId ?? null,
    originalIndex: 0,
  };
}

function discovery(id: string, score: number): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: `discovery:${id}`,
    candidate: candidate(id, `Discovery ${id}`, `artist-${id}`),
    rawScore: score,
    adjustedScore: score,
    historyClass: "NEW_TRACK_KNOWN_ARTIST",
    pathLabel: "root → direct",
    resolutionReason: "EXACT_TRACK_ARTIST_MATCH",
    isrc: `ISRC-${id}`,
  };
}

function candidate(id: string, title: string, artistId: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title,
    subtitle: `Artist ${artistId}`,
    spotifyTrackId: id,
    primaryArtistId: artistId,
    primaryArtistName: `Artist ${artistId}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs: 180_000,
  };
}
