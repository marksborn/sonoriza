import assert from "node:assert/strict";
import test from "node:test";

import {
  planRun,
  type Candidate,
  type PlanRunResult,
  type RunTarget,
} from "@/services/playlist-planner";

import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import { applyDiscoveryGate5H } from "./planner-discovery-gate5h";

test("MUSIC-VERSION-01 Gate 4 makes Gate 5H prefer studio over a higher pre-version LIVE score", () => {
  const runTarget = target("pilot", 5 * 180_000);
  const result = applyDiscoveryGate5H({
    baseline: baselineFor(runTarget, 5),
    targets: [runTarget],
    discoveries: [
      discovery("live", 80, "Candidate Song - Live at Wembley", "Live at Wembley"),
      discovery("studio", 75, "Candidate Song", "Studio Album"),
    ],
  });

  assert.equal(result.applied, true);
  assert.equal(result.selectedDiscoveryCount, 1);
  assert.equal(result.preview?.targets[0]?.replacements[0]?.candidateKey, "studio");
  assert.equal(result.preview?.targets[0]?.replacements[0]?.adjustedScore, 75);

  const unusedLive = result.preview?.unusedDiscoveries.find(
    (row) => row.candidateKey === "live",
  );
  assert.equal(unusedLive?.adjustedScore, 72);
  assert.match(unusedLive?.resolutionReason ?? "", /VERSION_LIVE_X0\.90/);
});

test("MUSIC-VERSION-01 Gate 4 still permits LIVE when it is the only resolved discovery", () => {
  const runTarget = target("pilot", 5 * 180_000);
  const result = applyDiscoveryGate5H({
    baseline: baselineFor(runTarget, 5),
    targets: [runTarget],
    discoveries: [
      discovery("live", 80, "Candidate Song - Live", "Live Album"),
    ],
  });

  assert.equal(result.applied, true);
  assert.equal(result.preview?.targets[0]?.replacements[0]?.candidateKey, "live");
  assert.equal(result.preview?.targets[0]?.replacements[0]?.adjustedScore, 72);
});

function target(id: string, durationMs: number): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 1,
    rules: {
      targetDurationMs: durationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function baselineFor(runTarget: RunTarget, count: number): PlanRunResult {
  return planRun({
    pools: {
      music: Array.from({ length: count }, (_, index) =>
        music(`baseline-${index + 1}`, `Baseline ${index + 1}`, `Album ${index + 1}`),
      ),
      podcasts: [],
    },
    targets: [runTarget],
  });
}

function discovery(
  id: string,
  score: number,
  title: string,
  albumName: string,
): Gate5FResolvedDiscoveryCandidate {
  return {
    candidateKey: id,
    candidate: music(id, title, albumName, 181_000),
    rawScore: score,
    adjustedScore: score,
    historyClass: "NEW_TRACK_KNOWN_ARTIST",
    pathLabel: "root → direct",
    resolutionReason: "EXACT_TRACK_ARTIST_MATCH",
    isrc: null,
  };
}

function music(
  id: string,
  title: string,
  albumName: string,
  durationMs = 180_000,
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title,
    subtitle: `Artist ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName,
    durationMs,
  };
}
