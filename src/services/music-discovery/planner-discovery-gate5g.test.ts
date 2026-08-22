import assert from "node:assert/strict";
import test from "node:test";

import type {
  Candidate,
  PlanRunResult,
  PlannedItem,
  RunTarget,
} from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import { previewSurgicalDiscoveryRun } from "./planner-discovery-gate5g";

test("Gate 5G replaces exactly the 5th and 10th MUSIC slots without touching podcasts", () => {
  const target = runTarget("t1", 12 * 60_000, { podcastPercent: 20 });
  const baselineItems = withPositions([
    music("m1", "a1"),
    podcast("p1"),
    music("m2", "a2"),
    music("m3", "a3"),
    music("m4", "a4"),
    podcast("p2"),
    music("m5", "a5"),
    music("m6", "a6"),
    music("m7", "a7"),
    music("m8", "a8"),
    music("m9", "a9"),
    music("m10", "a10"),
  ]);
  const result = previewSurgicalDiscoveryRun({
    baseline: baseline("t1", baselineItems),
    targets: [target],
    discoveries: [discovery("d1", 80), discovery("d2", 70)],
  });

  const preview = result.targets[0]!;
  assert.deepEqual(preview.replacements.map((row) => row.musicOrdinal), [5, 10]);
  assert.deepEqual(preview.replacements.map((row) => row.overallPosition), [7, 12]);
  assert.deepEqual(
    preview.items.filter((item) => item.type === "PODCAST").map((item) => item.uri),
    ["spotify:episode:p1", "spotify:episode:p2"],
  );
  assert.equal(preview.evidence.podcastSequenceUnchanged, true);
  assert.equal(preview.evidence.podcastCountUnchanged, true);
  assert.equal(preview.evidence.musicCountUnchanged, true);
  assert.equal(preview.evidence.oneForOneReplacement, true);
  assert.equal(preview.evidence.discoveryShare, 0.2);
});

test("Gate 5G does not force-fill a playlist with fewer than five MUSIC items", () => {
  const items = withPositions([music("m1", "a1"), music("m2", "a2"), music("m3", "a3"), music("m4", "a4")]);
  const result = previewSurgicalDiscoveryRun({
    baseline: baseline("t1", items),
    targets: [runTarget("t1", 4 * 60_000)],
    discoveries: [discovery("d1", 80)],
  });

  assert.equal(result.targets[0]?.replacements.length, 0);
  assert.equal(result.unusedDiscoveries.length, 1);
});

test("Gate 5G rejects a replacement outside the 30 second duration tolerance", () => {
  const items = withPositions(Array.from({ length: 5 }, (_, index) => music(`m${index + 1}`, `a${index + 1}`)));
  const tooLong = discovery("d1", 80, 91_000);
  const result = previewSurgicalDiscoveryRun({
    baseline: baseline("t1", items),
    targets: [runTarget("t1", 5 * 60_000)],
    discoveries: [tooLong],
  });

  assert.equal(result.targets[0]?.replacements.length, 0);
  assert.equal(result.targets[0]?.attemptsRejected[0]?.reason, "DURATION_DELTA_EXCEEDED");
});

test("Gate 5G preserves configured artist diversity limits", () => {
  const items = withPositions(Array.from({ length: 5 }, (_, index) => music(`m${index + 1}`, `a${index + 1}`)));
  const target = runTarget("t1", 5 * 60_000, { maxTracksPerArtist: 1 });
  const sameArtist = discovery("d1", 80, 60_000, "a1");
  const result = previewSurgicalDiscoveryRun({
    baseline: baseline("t1", items),
    targets: [target],
    discoveries: [sameArtist],
  });

  assert.equal(result.targets[0]?.replacements.length, 0);
  assert.equal(result.targets[0]?.attemptsRejected[0]?.reason, "ARTIST_LIMIT");
});

test("Gate 5G uses each discovery at most once across destinations", () => {
  const items1 = withPositions(Array.from({ length: 5 }, (_, index) => music(`a-m${index + 1}`, `a${index + 1}`)));
  const items2 = withPositions(Array.from({ length: 5 }, (_, index) => music(`b-m${index + 1}`, `b${index + 1}`)));
  const result = previewSurgicalDiscoveryRun({
    baseline: {
      targets: [
        baselineTarget("t1", items1),
        baselineTarget("t2", items2),
      ],
    } as unknown as PlanRunResult,
    targets: [runTarget("t1", 5 * 60_000), runTarget("t2", 5 * 60_000)],
    discoveries: [discovery("d1", 80)],
  });

  assert.equal(result.targets[0]?.replacements.length, 1);
  assert.equal(result.targets[1]?.replacements.length, 0);
  assert.equal(result.evidence.selectedDiscoveryCount, 1);
});

test("Gate 5G leaves a blocked discovery available for a later destination", () => {
  const items1 = withPositions(Array.from({ length: 5 }, (_, index) => music(`a-m${index + 1}`, `a${index + 1}`)));
  const items2 = withPositions(Array.from({ length: 5 }, (_, index) => music(`b-m${index + 1}`, `b${index + 1}`)));
  const candidate = discovery("d1", 80);
  const result = previewSurgicalDiscoveryRun({
    baseline: {
      targets: [baselineTarget("t1", items1), baselineTarget("t2", items2)],
    } as unknown as PlanRunResult,
    targets: [runTarget("t1", 5 * 60_000), runTarget("t2", 5 * 60_000)],
    discoveries: [candidate],
    blockedMusicTrackIdsByTargetId: new Map([
      ["t1", new Set([candidate.candidate.spotifyTrackId!])],
    ]),
  });

  assert.equal(result.targets[0]?.replacements.length, 0);
  assert.equal(result.targets[0]?.attemptsRejected[0]?.reason, "BLOCKED_TRACK");
  assert.equal(result.targets[1]?.replacements.length, 1);
});

test("Gate 5G rejects a substitution that would regress a valid PROPORTION plan", () => {
  const items = withPositions([
    music("m1", "a1"),
    music("m2", "a2"),
    music("m3", "a3"),
    music("m4", "a4"),
    podcast("p1", 300_000),
    music("m5", "a5"),
  ]);
  const target = runTarget("t1", 600_000, { podcastPercent: 50 });
  const shorter = discovery("d1", 80, 40_000);
  const result = previewSurgicalDiscoveryRun({
    baseline: baseline("t1", items),
    targets: [target],
    discoveries: [shorter],
  });

  assert.equal(result.targets[0]?.replacements.length, 0);
  assert.equal(result.targets[0]?.attemptsRejected[0]?.reason, "QUALITY_REGRESSION");
  assert.equal(result.targets[0]?.evidence.compositionQualityPreserved, true);
});

function baseline(targetId: string, items: PlannedItem[]): PlanRunResult {
  return { targets: [baselineTarget(targetId, items)] } as unknown as PlanRunResult;
}

function baselineTarget(targetId: string, items: PlannedItem[]) {
  return {
    targetPlaylistId: targetId,
    name: targetId,
    result: {
      items,
      stats: {
        compositionQualityPassed: true,
        segmentation: undefined,
      },
    },
  };
}

function runTarget(
  id: string,
  targetDurationMs: number,
  overrides: Partial<RunTarget["rules"]> = {},
): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 0,
    rules: {
      targetDurationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 10,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
      ...overrides,
    },
  };
}

function withPositions(items: Candidate[]): PlannedItem[] {
  return items.map((item, position) => ({ ...item, position }));
}

function music(id: string, artistId: string, durationMs = 60_000): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: artistId,
    primaryArtistName: artistId,
    albumId: `album:${id}`,
    albumName: `album:${id}`,
    durationMs,
  };
}

function podcast(id: string, durationMs = 60_000): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    programId: `program:${id}`,
    durationMs,
  };
}

function discovery(
  key: string,
  adjustedScore: number,
  durationMs = 60_000,
  artistId = `artist:${key}`,
): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: key,
    candidate: music(`track:${key}`, artistId, durationMs),
    rawScore: adjustedScore,
    adjustedScore,
    historyClass: "NEW_TRACK_KNOWN_ARTIST",
    pathLabel: "root → direct",
    resolutionReason: "EXACT_TRACK_ARTIST_MATCH",
    isrc: `ISRC-${key}`,
  };
}
