import assert from "node:assert/strict";
import test from "node:test";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { planPlaylist } from "./planner";
import { projectCountReserveShadow } from "./playback-reserve-count-shadow";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function rules(overrides: Partial<PlaylistRules> = {}): PlaylistRules {
  return {
    targetDurationMs: 4 * MINUTE,
    compositionMode: "PROPORTION",
    podcastPercent: 0,
    sequencePattern: [],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
    ...overrides,
  };
}

function music(
  id: string,
  artistId = `artist-${id}`,
  albumId = `album-${id}`,
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: artistId,
    albumId,
    durationMs: 4 * MINUTE,
  };
}

function podcast(
  id: string,
  programId: string,
  minutes = 20,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId,
    durationMs: minutes * MINUTE,
    ...overrides,
  };
}

function musicPolicy(count: number): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: "target",
    source: "GLOBAL",
    reserveMode: "MUSIC_TRACKS",
    durationSeconds: null,
    musicTrackCount: count,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  };
}

function podcastPolicy(count: number): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: "target",
    source: "GLOBAL",
    reserveMode: "PODCAST_EPISODES",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: count,
    podcastInDurationReserve: "DISABLED",
  };
}

function emptyPrimary(inputRules = rules()) {
  return planPlaylist({
    rules: { ...inputRules, targetDurationMs: 0 },
    pools: { music: [], podcasts: [] },
  });
}

test("Gate 4 MUSIC_TRACKS selects exactly the requested count when eligible candidates exist", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: musicPolicy(2),
    primary: emptyPrimary(),
    rules: rules(),
    pools: {
      music: [music("m1"), music("m2"), music("m3")],
      podcasts: [],
    },
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.reserve.mode, "MUSIC_TRACKS");
  assert.equal(result.reserve.requestedCount, 2);
  assert.equal(result.reserve.plannedCount, 2);
  assert.equal(result.reserve.shortfallCount, 0);
  assert.deepEqual(
    result.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:m1", "spotify:track:m2"],
  );
  assert.ok(result.reserve.selectedItems.every((item) => item.role === "RESERVE"));
});

test("Gate 4 MUSIC_TRACKS counts PRIMARY for artist diversity", () => {
  const diversityRules = rules({ maxTracksPerArtist: 1 });
  const primary = planPlaylist({
    rules: diversityRules,
    pools: {
      music: [music("primary", "artist-a")],
      podcasts: [],
    },
  });

  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: musicPolicy(1),
    primary,
    rules: diversityRules,
    pools: {
      music: [
        music("primary", "artist-a"),
        music("same-artist", "artist-a"),
        music("eligible", "artist-b"),
      ],
      podcasts: [],
    },
  });

  assert.deepEqual(
    result.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:eligible"],
  );
});

test("Gate 4 MUSIC_TRACKS reports count shortfall instead of bypassing eligibility", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: musicPolicy(3),
    primary: emptyPrimary(),
    rules: rules(),
    pools: {
      music: [music("only")],
      podcasts: [],
    },
  });

  assert.equal(result.status, "SHORTFALL");
  assert.equal(result.reserve.plannedCount, 1);
  assert.equal(result.reserve.shortfallCount, 2);
});

test("Gate 4 PODCAST_EPISODES selects episodes by canonical order and never falls back to music", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: podcastPolicy(2),
    primary: emptyPrimary(),
    rules: rules({ maxEpisodesPerProgram: 1 }),
    pools: {
      music: [music("must-not-fallback")],
      podcasts: [
        podcast("p1", "show-a"),
        podcast("p2", "show-b"),
        podcast("p3", "show-c"),
      ],
    },
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.reserve.mode, "PODCAST_EPISODES");
  assert.equal(result.reserve.fallbackApplied, false);
  assert.equal(result.reserve.musicCount, 0);
  assert.deepEqual(
    result.reserve.selectedItems.map((item) => item.uri),
    ["spotify:episode:p1", "spotify:episode:p2"],
  );
});

test("Gate 4 PODCAST_EPISODES shortfall stays podcast-only", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: podcastPolicy(2),
    primary: emptyPrimary(),
    rules: rules({ maxEpisodesPerProgram: 1 }),
    pools: {
      music: [music("available-music")],
      podcasts: [podcast("only", "show-a")],
    },
  });

  assert.equal(result.status, "SHORTFALL");
  assert.equal(result.reserve.plannedCount, 1);
  assert.equal(result.reserve.shortfallCount, 1);
  assert.equal(result.reserve.musicCount, 0);
  assert.equal(result.reserve.fallbackApplied, false);
});

test("Gate 4 PODCAST_EPISODES respects PRIMARY/global show cap consumption", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: podcastPolicy(1),
    primary: emptyPrimary(),
    rules: rules({ maxEpisodesPerProgram: 1 }),
    pools: {
      music: [],
      podcasts: [podcast("a-next", "show-a"), podcast("b", "show-b")],
    },
    podcastProgramCounts: new Map([["show-a", 1]]),
  });

  assert.deepEqual(
    result.reserve.selectedItems.map((item) => item.uri),
    ["spotify:episode:b"],
  );
});

test("Gate 4 strict podcast sequence does not jump over an invalid head episode", () => {
  const result = projectCountReserveShadow({
    targetPlaylistId: "target",
    targetName: "Target",
    policy: podcastPolicy(1),
    primary: emptyPrimary(),
    rules: rules({ maxPodcastDurationMs: 30 * MINUTE }),
    pools: {
      music: [],
      podcasts: [
        podcast("strict-too-long", "show-a", 40, {
          podcastStrictSequence: true,
        }),
        podcast("strict-later", "show-a", 20, {
          podcastStrictSequence: true,
        }),
        podcast("other-show", "show-b", 20),
      ],
    },
  });

  assert.deepEqual(
    result.reserve.selectedItems.map((item) => item.uri),
    ["spotify:episode:other-show"],
  );
});
