import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import type { DiscoveryPlannerPoolEntry } from "./planner-bridge";
import {
  projectTargetDiscoveryPlannerInput,
  targetDiscoveryCandidateIds,
} from "./target-discovery-planner";

test("master off preserves every normal source candidate in source order and admits no external discovery", () => {
  const projection = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "carro",
    persistedPolicy: { discoveryEnabled: false },
    sourceEntries: [
      source("r1", "REDESCOBERTA", 0.95, 2),
      source("f1", "FAMILIAR", 0.9, 0),
      source("s1", "SOURCE_FALLBACK", null, 1),
    ],
    externalDiscoveries: [external("new1", 0.99)],
  });

  assert.deepEqual(
    projection.sourceEntries.map((entry) => entry.candidate.spotifyTrackId),
    ["f1", "s1", "r1"],
  );
  assert.ok(projection.sourceEntries.every((entry) => entry.category === "SOURCE_FALLBACK"));
  assert.equal(projection.evidence.sourceCandidateCountPreserved, 3);
  assert.equal(projection.evidence.demotedByPolicyCount, 2);
  assert.equal(projection.evidence.admittedExternalDiscoveryCount, 0);
  assert.deepEqual(targetDiscoveryCandidateIds(projection), ["f1", "s1", "r1"]);
});

test("Familiaridade promotes only familiar source matches while rediscovery remains a normal source candidate", () => {
  const projection = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "trabalho",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: false,
      discoveryNoveltyEnabled: false,
      discoveryReleasesEnabled: false,
    },
    sourceEntries: [
      source("r1", "REDESCOBERTA", 0.99, 0),
      source("f1", "FAMILIAR", 0.8, 2),
      source("s1", "SOURCE_FALLBACK", null, 1),
    ],
  });

  assert.deepEqual(
    projection.sourceEntries.map((entry) => [
      entry.candidate.spotifyTrackId,
      entry.category,
    ]),
    [
      ["f1", "FAMILIAR"],
      ["r1", "SOURCE_FALLBACK"],
      ["s1", "SOURCE_FALLBACK"],
    ],
  );
  assert.equal(projection.evidence.familiarPromotedCount, 1);
  assert.equal(projection.evidence.rediscoveryPromotedCount, 0);
  assert.equal(projection.evidence.outputSourceCount, 3);
});

test("Redescoberta obeys the existing planner ceiling but never drops source candidates", () => {
  const projection = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "academia",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: false,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: false,
      discoveryReleasesEnabled: false,
    },
    sourceEntries: [
      source("r1", "REDESCOBERTA", 0.99, 0),
      source("r2", "REDESCOBERTA", 0.98, 1),
      source("f1", "FAMILIAR", 0.9, 2),
      source("s1", "SOURCE_FALLBACK", null, 3),
      source("s2", "SOURCE_FALLBACK", null, 4),
      source("s3", "SOURCE_FALLBACK", null, 5),
    ],
  });

  assert.equal(projection.evidence.rediscoveryPromotedCount, 2);
  assert.equal(projection.evidence.familiarPromotedCount, 0);
  assert.equal(projection.evidence.outputSourceCount, 6);
  assert.deepEqual(
    new Set(projection.sourceEntries.map((entry) => entry.candidate.spotifyTrackId)),
    new Set(["r1", "r2", "f1", "s1", "s2", "s3"]),
  );
  assert.ok(
    projection.sourceEntries.find((entry) => entry.candidate.spotifyTrackId === "f1")
      ?.category === "SOURCE_FALLBACK",
  );
});

test("Descoberta admits resolved external tracks only for a target that enabled that family", () => {
  const sourceEntries = Array.from({ length: 5 }, (_, index) =>
    source(`s${index + 1}`, "SOURCE_FALLBACK", null, index),
  );
  const discovery = external("new1", 0.99);

  const enabled = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "avulsa",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: false,
      discoveryRediscoveryEnabled: false,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: false,
    },
    sourceEntries,
    externalDiscoveries: [discovery],
  });
  const disabled = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "carro",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: false,
      discoveryReleasesEnabled: false,
    },
    sourceEntries,
    externalDiscoveries: [discovery],
  });

  assert.equal(enabled.evidence.admittedExternalDiscoveryCount, 1);
  assert.ok(targetDiscoveryCandidateIds(enabled).includes("new1"));
  assert.equal(disabled.evidence.admittedExternalDiscoveryCount, 0);
  assert.ok(!targetDiscoveryCandidateIds(disabled).includes("new1"));
});

test("Novidades without a provider abstains without inventing candidates or blocking normal sources", () => {
  const projection = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "carro",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryFamiliarEnabled: false,
      discoveryRediscoveryEnabled: false,
      discoveryNoveltyEnabled: false,
      discoveryReleasesEnabled: true,
      discoveryIntensity: "EXPLORATORY",
    },
    sourceEntries: [
      source("s1", "SOURCE_FALLBACK", null, 0),
      source("s2", "SOURCE_FALLBACK", null, 1),
    ],
  });

  assert.deepEqual(projection.configuredFamilies, ["RELEASE"]);
  assert.deepEqual(projection.effectiveFamilies, []);
  assert.equal(projection.evidence.releaseProviderAvailable, false);
  assert.equal(projection.evidence.releaseRequestedButUnavailable, true);
  assert.deepEqual(targetDiscoveryCandidateIds(projection), ["s1", "s2"]);
});

test("intensity is carried as ordinal calibration evidence and never creates a mandatory fill quota", () => {
  const sourceEntries = Array.from({ length: 5 }, (_, index) =>
    source(`s${index + 1}`, "SOURCE_FALLBACK", null, index),
  );
  const externalDiscoveries = [external("new1", 0.99)];

  const conservative = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "x",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryIntensity: "CONSERVATIVE",
    },
    sourceEntries,
    externalDiscoveries,
  });
  const exploratory = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "x",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryIntensity: "EXPLORATORY",
    },
    sourceEntries,
    externalDiscoveries,
  });

  assert.equal(conservative.evidence.intensityRank, 1);
  assert.equal(exploratory.evidence.intensityRank, 3);
  assert.equal(conservative.evidence.forcedFill, false);
  assert.equal(exploratory.evidence.forcedFill, false);
  assert.deepEqual(
    targetDiscoveryCandidateIds(conservative),
    targetDiscoveryCandidateIds(exploratory),
  );
});

test("projection evidence keeps target provenance and albums remain outside the gate", () => {
  const projection = projectTargetDiscoveryPlannerInput({
    targetPlaylistId: "target-123",
    persistedPolicy: {
      discoveryEnabled: true,
      discoveryNoveltyEnabled: true,
    },
    sourceEntries: Array.from({ length: 5 }, (_, index) =>
      source(`s${index + 1}`, "SOURCE_FALLBACK", null, index),
    ),
    externalDiscoveries: [external("new1", 0.99)],
  });

  assert.equal(projection.evidence.targetPlaylistId, "target-123");
  assert.equal(projection.evidence.albumCandidatesAccepted, 0);
  const promoted = projection.blend.entries.find(
    (entry) => entry.origin === "EXTERNAL_DISCOVERY",
  );
  assert.equal(promoted?.historyClass, "UNSEEN");
  assert.equal(promoted?.pathLabel, "LASTFM_SIMILAR");
  assert.equal(promoted?.resolutionReason, "SPOTIFY_RESOLVED");
});

function source(
  id: string,
  category: DiscoveryPlannerPoolEntry["category"],
  score: number | null,
  originalIndex: number,
): DiscoveryPlannerPoolEntry {
  return {
    candidate: music(id),
    category,
    score,
    matchSource: category === "SOURCE_FALLBACK" ? "NONE" : "SPOTIFY_TRACK_ID",
    matchedScoreTrackId: category === "SOURCE_FALLBACK" ? null : id,
    originalIndex,
  };
}

function external(id: string, adjustedScore: number): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: `candidate:${id}`,
    candidate: music(id),
    rawScore: adjustedScore,
    adjustedScore,
    historyClass: "UNSEEN",
    pathLabel: "LASTFM_SIMILAR",
    resolutionReason: "SPOTIFY_RESOLVED",
    isrc: `ISRC-${id}`,
  };
}

function music(id: string): Candidate {
  return {
    type: "MUSIC",
    uri: `spotify:track:${id}`,
    spotifyTrackId: id,
    title: `Track ${id}`,
    subtitle: `Artist ${id}`,
    primaryArtistId: `artist:${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album:${id}`,
    albumName: `Album ${id}`,
    durationMs: 180_000,
  };
}
