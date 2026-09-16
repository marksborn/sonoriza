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

function music(
  id: string,
  sourcePlaylistId = "source-ok",
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    albumId: `album-${id}`,
    sourcePlaylistId,
    durationMs: 4 * MINUTE,
  };
}

function podcast(id: string, programId: string): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId,
    durationMs: 20 * MINUTE,
    sourcePlaylistId: "source-ok",
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

function musicPolicy(
  targetPlaylistId: string,
  count: number,
): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId,
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount: count,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function podcastPolicy(
  targetPlaylistId: string,
  count: number,
): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId,
    source: "GLOBAL",
    reserveMode: "PODCAST_EPISODES",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: count,
    podcastInDurationReserve: "DISABLED",
  };
}

function nonePolicy(
  targetPlaylistId: string,
): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId,
    source: "GLOBAL",
    reserveMode: "NONE",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function runtime(
  policies: ReadonlyMap<string, EffectivePlaybackReservePolicySnapshot>,
): PlaybackReserveShadowRuntimeState {
  return {
    gate: 4,
    mode: "SHADOW",
    plannerInfluence: false,
    spotifyWriteInfluence: false,
    additionalProviderReads: false,
    policies,
    evidence: null,
  };
}

function primaryProjection(result: ReturnType<typeof baselinePlanRun>) {
  return result.targets.map((target) => ({
    targetPlaylistId: target.targetPlaylistId,
    items: target.result.items.map((item) => ({ ...item })),
    stats: structuredClone(target.result.stats),
    usedUris: [...target.result.usedUris].sort(),
  }));
}

test("Gate 4 MUSIC_TRACKS keeps all PRIMARY immutable before selecting reserve", () => {
  const input = {
    pools: {
      music: [music("primary-a"), music("primary-b"), music("reserve")],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "a", name: "A", priority: 1, rules: rules() },
      { targetPlaylistId: "b", name: "B", priority: 2, rules: rules() },
    ],
  };
  const baseline = baselinePlanRun(input);
  const result = runWithPlaybackReserveShadowRuntimeState(
    runtime(
      new Map([
        ["a", musicPolicy("a", 1)],
        ["b", nonePolicy("b")],
      ]),
    ),
    () => planRun(input),
  );

  assert.deepEqual(primaryProjection(result), primaryProjection(baseline));
  assert.equal(result.playbackReserveShadow?.gate, 4);
  const a = result.playbackReserveShadow?.targets.find(
    (entry) => entry.targetPlaylistId === "a",
  );
  assert.ok(a && a.reserve && "mode" in a.reserve);
  assert.deepEqual(
    a.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:reserve"],
  );
});

test("Gate 4 MUSIC_TRACKS reuses target source scope and target-local blocked music", () => {
  const input = {
    pools: {
      music: [
        music("primary"),
        music("wrong-source", "source-other"),
        music("blocked"),
        music("eligible"),
      ],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "target", name: "Target", priority: 1, rules: rules() },
    ],
    sourceIdsByTargetId: new Map([["target", new Set(["source-ok"])]]),
    blockedMusicTrackIdsByTargetId: new Map([
      ["target", new Set(["blocked"])],
    ]),
  };

  const result = runWithPlaybackReserveShadowRuntimeState(
    runtime(new Map([["target", musicPolicy("target", 2)]])),
    () => planRun(input),
  );
  const target = result.playbackReserveShadow?.targets[0];
  assert.ok(target && target.reserve && "mode" in target.reserve);
  assert.equal(target.status, "SHORTFALL");
  assert.deepEqual(
    target.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:eligible"],
  );
});

test("Gate 4 PODCAST_EPISODES remains podcast-only through planRun", () => {
  const input = {
    pools: {
      music: [music("primary"), music("fallback")],
      podcasts: [podcast("episode", "show-a")],
    },
    targets: [
      { targetPlaylistId: "target", name: "Target", priority: 1, rules: rules() },
    ],
    sourceIdsByTargetId: new Map([["target", new Set(["source-ok"])]]),
  };

  const result = runWithPlaybackReserveShadowRuntimeState(
    runtime(new Map([["target", podcastPolicy("target", 2)]])),
    () => planRun(input),
  );
  const target = result.playbackReserveShadow?.targets[0];
  assert.ok(target && target.reserve && "mode" in target.reserve);
  assert.equal(target.status, "SHORTFALL");
  assert.equal(target.reserve.musicCount, 0);
  assert.deepEqual(
    target.reserve.selectedItems.map((item) => item.uri),
    ["spotify:episode:episode"],
  );
});
