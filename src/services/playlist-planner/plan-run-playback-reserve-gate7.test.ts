import assert from "node:assert/strict";
import test from "node:test";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";
import {
  runWithPlaybackReserveShadowRuntimeState,
  type PlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";
import { applyMusicOrder } from "@/services/playlist-ordering";

import { planRun as baselinePlanRun } from "./plan-run-podcast07";
import {
  PLAYBACK_RESERVE_ORDERING_BLOCK_INDEX,
  planRun,
} from "./plan-run-playback-reserve";
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

function policy(musicTrackCount = 1): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: "target",
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function activeState(musicTrackCount = 1): PlaybackReserveShadowRuntimeState {
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
    policies: new Map([["target", policy(musicTrackCount)]]),
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
  assert.equal(
    target.result.items[1]?.planningBlockIndex,
    PLAYBACK_RESERVE_ORDERING_BLOCK_INDEX,
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

test("ORDER-01 cannot move RESERVE music into PRIMARY slots", () => {
  const input = {
    pools: {
      music: [music("primary"), music("reserve-a"), music("reserve-b")],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "target", name: "Target", priority: 1, rules: rules() },
    ],
  };

  const state = activeState(2);
  const result = runWithPlaybackReserveShadowRuntimeState(state, () => planRun(input));
  const target = result.targets[0]!;
  const reserveStart = state.evidence?.targets[0]?.reserve?.startsAtPosition;

  assert.equal(reserveStart, 1);
  assert.deepEqual(
    target.result.items.slice(1).map((item) => item.planningBlockIndex),
    [PLAYBACK_RESERVE_ORDERING_BLOCK_INDEX, PLAYBACK_RESERVE_ORDERING_BLOCK_INDEX],
  );

  // Without the ordering fence, seed-0 ranks reserve-a before primary and would
  // move it into position 0. The dedicated RESERVE block must prevent that.
  const ordered = applyMusicOrder(
    target.result.items,
    "RANDOMIZED",
    "seed-0",
    "RUN",
  ).items;

  assert.equal(ordered[0]?.uri, "spotify:track:primary");
  assert.deepEqual(
    new Set(ordered.slice(1).map((item) => item.uri)),
    new Set(["spotify:track:reserve-a", "spotify:track:reserve-b"]),
  );
});
