import assert from "node:assert/strict";
import test from "node:test";

import {
  planRun,
  type Candidate,
  type PlaylistRules,
  type RunTarget,
} from "@/services/playlist-planner";

const rules: PlaylistRules = {
  targetDurationMs: 180_000,
  compositionMode: "PROPORTION",
  podcastPercent: 0,
  sequencePattern: [],
  maxEpisodesPerProgram: 1,
  maxPodcastDurationMs: null,
  maxTracksPerArtist: null,
  maxTracksPerAlbum: null,
};

const targets: RunTarget[] = [
  { targetPlaylistId: "trabalho", name: "Trabalho", priority: 1, rules },
  { targetPlaylistId: "academia", name: "Academia", priority: 2, rules },
];

const a = music("a");
const b = music("b");

test("planRun preserves the legacy shared-pool behavior when no target override exists", () => {
  const plan = planRun({
    pools: { music: [a, b], podcasts: [] },
    targets,
  });

  assert.deepEqual(
    plan.targets.map((target) => target.result.items[0]?.spotifyTrackId),
    ["a", "b"],
  );
});

test("planRun uses an independent music ordering per destination while keeping run-wide URI reservation", () => {
  const plan = planRun({
    pools: { music: [a, b], podcasts: [] },
    targets,
    musicPoolByTargetId: new Map([
      ["trabalho", [b, a]],
      ["academia", [a, b]],
    ]),
  });

  assert.deepEqual(
    plan.targets.map((target) => target.result.items[0]?.spotifyTrackId),
    ["b", "a"],
  );
  assert.equal(
    new Set(plan.targets.flatMap((target) => target.result.items.map((item) => item.uri))).size,
    2,
  );
});

test("MUSIC-05 per-target blocks remain authoritative after target pool projection", () => {
  const plan = planRun({
    pools: { music: [a, b], podcasts: [] },
    targets,
    musicPoolByTargetId: new Map([
      ["trabalho", [b, a]],
      ["academia", [a, b]],
    ]),
    blockedMusicTrackIdsByTargetId: new Map([
      ["trabalho", new Set(["b"])],
    ]),
  });

  assert.equal(plan.targets[0]?.result.items[0]?.spotifyTrackId, "a");
  assert.equal(plan.targets[1]?.result.items[0]?.spotifyTrackId, "b");
});

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: `Track ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist:${id}`,
    albumId: `album:${id}`,
    durationMs: 180_000,
  };
}
