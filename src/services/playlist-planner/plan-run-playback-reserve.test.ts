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
  minutes = 4,
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
    durationMs: minutes * MINUTE,
  };
}

function rules(targetMinutes = 4): PlaylistRules {
  return {
    targetDurationMs: targetMinutes * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  };
}

function durationPolicy(
  targetPlaylistId: string,
  minutes: number,
): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId,
    source: "GLOBAL",
    reserveMode: "DURATION",
    durationSeconds: minutes * 60,
    musicTrackCount: null,
    podcastEpisodeCount: null,
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
    gate: 5,
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
    name: target.name,
    items: target.result.items.map((item) => ({ ...item })),
    stats: structuredClone(target.result.stats),
    usedUris: [...target.result.usedUris].sort(),
  }));
}

test("Gate 3 computes all PRIMARY first so RESERVE cannot steal a later PRIMARY", () => {
  const input = {
    pools: {
      music: [music("primary-a"), music("primary-b"), music("reserve-a")],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "a", name: "A", priority: 1, rules: rules() },
      { targetPlaylistId: "b", name: "B", priority: 2, rules: rules() },
    ],
  };
  const baseline = baselinePlanRun(input);
  const baselinePrimary = primaryProjection(baseline);

  const state = runtime(
    new Map([
      ["a", durationPolicy("a", 4)],
      ["b", nonePolicy("b")],
    ]),
  );
  const shadowed = runWithPlaybackReserveShadowRuntimeState(state, () =>
    planRun(input),
  );

  assert.deepEqual(primaryProjection(shadowed), baselinePrimary);
  assert.equal(shadowed.playbackReserveShadow?.plannerInfluence, false);
  const a = shadowed.playbackReserveShadow?.targets.find(
    (target) => target.targetPlaylistId === "a",
  );
  assert.ok(a && a.reserve);
  assert.deepEqual(
    a.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:reserve-a"],
  );
  assert.ok(
    !a.reserve.selectedItems.some(
      (item) => item.uri === "spotify:track:primary-b",
    ),
  );
});

test("Gate 3 reserve reuses source scope and target-local blocked music filters", () => {
  const input = {
    pools: {
      music: [
        music("primary"),
        music("wrong-source", 4, "source-other"),
        music("blocked"),
        music("eligible"),
      ],
      podcasts: [],
    },
    targets: [
      { targetPlaylistId: "target", name: "Target", priority: 1, rules: rules() },
    ],
    sourceIdsByTargetId: new Map([
      ["target", new Set(["source-ok"])],
    ]),
    blockedMusicTrackIdsByTargetId: new Map([
      ["target", new Set(["blocked"])],
    ]),
  };

  const state = runtime(
    new Map([["target", durationPolicy("target", 4)]]),
  );
  const result = runWithPlaybackReserveShadowRuntimeState(state, () =>
    planRun(input),
  );
  const target = result.playbackReserveShadow?.targets[0];
  assert.ok(target && target.reserve);
  assert.deepEqual(
    target.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:eligible"],
  );
});

test("CALENDAR/PER_EVENT PRIMARY blocks stay intact and DURATION reserve is one final shadow segment", () => {
  const input = {
    pools: {
      music: [
        music("p1", 2),
        music("p2", 2),
        music("reserve", 2),
      ],
      podcasts: [],
    },
    targets: [
      {
        targetPlaylistId: "calendar",
        name: "Calendar",
        priority: 1,
        rules: rules(4),
        durationBlocks: [
          { key: "e1", targetDurationMs: 2 * MINUTE, eventId: "e1" },
          { key: "e2", targetDurationMs: 2 * MINUTE, eventId: "e2" },
        ],
      },
    ],
  };
  const baseline = baselinePlanRun(input);
  const state = runtime(
    new Map([["calendar", durationPolicy("calendar", 2)]]),
  );
  const result = runWithPlaybackReserveShadowRuntimeState(state, () =>
    planRun(input),
  );

  assert.deepEqual(primaryProjection(result), primaryProjection(baseline));
  assert.equal(result.targets[0]?.result.stats.segmentation?.blocks.length, 2);
  const target = result.playbackReserveShadow?.targets[0];
  assert.ok(target && target.reserve);
  assert.equal(target.primary.segmentationBlockCount, 2);
  assert.equal(target.reserve.startsAtPosition, 2);
  assert.deepEqual(
    target.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:reserve"],
  );
});
