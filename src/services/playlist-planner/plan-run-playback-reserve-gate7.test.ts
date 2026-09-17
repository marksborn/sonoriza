import assert from "node:assert/strict";
import test from "node:test";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";
import {
  runWithPlaybackReserveShadowRuntimeState,
  type PlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";

import { planRun as baselinePlanRun } from "./plan-run-podcast07";
import { planRun } from "./plan-run-playback-reserve";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    albumId: `album-${id}`,
    durationMs: 4 * MINUTE,
  };
}

function rules(): PlaylistRules {
  return {
    targetDurationMs: 4 * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  };
}

function policy(): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: "target",
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount: 1,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function activeState(): PlaybackReserveShadowRuntimeState {
  return {
    gate: 7,
    configuredMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    simulate: true,
    plannerInfluence: true,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    status: "READY_ACTIVE_SIMULATION",
    targetPlaylistIds: ["target"],
    allowedTargetIds: new Set(["target"]),
    policies: new Map([["target", policy()]]),
    simulationApprovalKey: "test-key",
    simulationApprovedRunId: null,
    rolePersistenceStatus: "PENDING",
    reserveRoleCount: 0,
    evidence: null,
  };
}

test("Gate 7 ACTIVE appends RESERVE after PRIMARY without changing PRIMARY quality authority", () => {
  const input = {
    pools: {
      music: [music("primary"), music("reserve")],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "target", name: "Target", priority: 1, rules: rules() },
    ],
  };

  const baseline = baselinePlanRun(input);
  const state = activeState();
  const result = runWithPlaybackReserveShadowRuntimeState(state, () => planRun(input));

  const baselineTarget = baseline.targets[0]!;
  const target = result.targets[0]!;

  assert.deepEqual(
    target.result.items.slice(0, baselineTarget.result.items.length),
    baselineTarget.result.items,
    "PRIMARY prefix must remain byte-equivalent",
  );
  assert.deepEqual(
    target.result.items.map((item) => item.uri),
    ["spotify:track:primary", "spotify:track:reserve"],
  );
  assert.deepEqual(
    target.result.stats,
    baselineTarget.result.stats,
    "RESERVE must not change PRIMARY quality/shortfall stats",
  );
  assert.equal(target.result.stats.totalDurationMs, 4 * MINUTE);
  assert.equal(result.playbackReserveShadow?.gate, 7);
  assert.equal(result.playbackReserveShadow?.mode, "ACTIVE");
  assert.equal(result.playbackReserveShadow?.plannerInfluence, true);
  assert.equal(result.playbackReserveShadow?.spotifyWriteInfluence, false);
  assert.equal(state.evidence?.mode, "ACTIVE");
});
