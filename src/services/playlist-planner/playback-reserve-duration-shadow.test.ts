import assert from "node:assert/strict";
import test from "node:test";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { planPlaylist } from "./planner";
import { projectDurationReserveShadow } from "./playback-reserve-duration-shadow";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function music(
  id: string,
  minutes: number,
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
    durationMs: minutes * MINUTE,
  };
}

function podcast(
  id: string,
  minutes: number,
  programId: string,
  strict = false,
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId,
    durationMs: minutes * MINUTE,
    podcastStrictSequence: strict,
    podcastMaxEpisodesPerCycle: 1,
  };
}

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

function durationPolicy(input: {
  targetPlaylistId?: string;
  minutes: number;
  podcast?: "DISABLED" | "IF_FITS";
}): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: input.targetPlaylistId ?? "target-1",
    source: "GLOBAL",
    reserveMode: "DURATION",
    durationSeconds: input.minutes * 60,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: input.podcast ?? "DISABLED",
  };
}

function primarySnapshot(result: ReturnType<typeof planPlaylist>) {
  return {
    items: result.items.map((item) => ({ ...item })),
    usedUris: [...result.usedUris].sort(),
    stats: structuredClone(result.stats),
  };
}

test("Gate 3 keeps PRIMARY identical and reports RESERVE separately", () => {
  const playlistRules = rules();
  const pool = [music("m1", 4), music("m2", 4), music("m3", 4)];
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: pool, podcasts: [] },
  });
  const before = primarySnapshot(primary);

  const shadow = projectDurationReserveShadow({
    targetPlaylistId: "target-1",
    targetName: "Carro",
    policy: durationPolicy({ minutes: 4 }),
    primary,
    rules: playlistRules,
    pools: { music: pool, podcasts: [] },
  });

  assert.deepEqual(primarySnapshot(primary), before);
  assert.equal(shadow.primary.itemCount, 1);
  assert.equal(shadow.reserve.startsAtPosition, primary.items.length);
  assert.deepEqual(
    shadow.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:m2"],
  );
  assert.equal(shadow.reserve.selectedItems[0]?.role, "RESERVE");
  assert.equal(shadow.plannerInfluence, false);
  assert.equal(shadow.spotifyWriteInfluence, false);
  assert.equal(shadow.additionalProviderReads, false);
});

test("Gate 3 diversity counts PRIMARY while selecting reserve music", () => {
  const playlistRules = rules({ maxTracksPerArtist: 1 });
  const pool = [
    music("primary-a", 4, "artist-a"),
    music("reserve-a", 4, "artist-a"),
    music("reserve-b", 4, "artist-b"),
  ];
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: pool, podcasts: [] },
  });

  const shadow = projectDurationReserveShadow({
    targetPlaylistId: "target-1",
    targetName: "Trabalho",
    policy: durationPolicy({ minutes: 4 }),
    primary,
    rules: playlistRules,
    pools: { music: pool, podcasts: [] },
  });

  assert.deepEqual(
    shadow.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:reserve-b"],
  );
});

test("DURATION + IF_FITS chooses at most one podcast by canonical order, not best fit", () => {
  const playlistRules = rules({ maxEpisodesPerProgram: 2 });
  const primaryMusic = music("primary", 4);
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [primaryMusic], podcasts: [] },
  });
  const podcasts = [
    podcast("priority-18", 18, "show-priority"),
    podcast("later-29", 29, "show-later"),
  ];
  const musicFill = [
    primaryMusic,
    music("fill-1", 4),
    music("fill-2", 4),
    music("fill-3", 4),
  ];

  const shadow = projectDurationReserveShadow({
    targetPlaylistId: "target-1",
    targetName: "Avulsa",
    policy: durationPolicy({ minutes: 30, podcast: "IF_FITS" }),
    primary,
    rules: playlistRules,
    pools: { music: musicFill, podcasts },
  });

  assert.equal(shadow.reserve.podcastCount, 1);
  assert.equal(shadow.reserve.podcastDecision, "RESERVE_PODCAST_SELECTED");
  assert.equal(
    shadow.reserve.selectedItems.find((item) => item.type === "PODCAST")?.uri,
    "spotify:episode:priority-18",
  );
  assert.ok(
    !shadow.reserve.selectedItems.some(
      (item) => item.uri === "spotify:episode:later-29",
    ),
  );
});

test("strict podcast sequence does not jump over an unfitting episode and falls back to music", () => {
  const playlistRules = rules({ maxEpisodesPerProgram: 2 });
  const primaryMusic = music("primary", 4);
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [primaryMusic], podcasts: [] },
  });

  const shadow = projectDurationReserveShadow({
    targetPlaylistId: "target-1",
    targetName: "Academia",
    policy: durationPolicy({ minutes: 30, podcast: "IF_FITS" }),
    primary,
    rules: playlistRules,
    pools: {
      music: [primaryMusic, music("fill", 30)],
      podcasts: [
        podcast("ep-1-too-long", 35, "strict-show", true),
        podcast("ep-2-would-fit", 10, "strict-show", true),
      ],
    },
  });

  assert.equal(
    shadow.reserve.podcastDecision,
    "RESERVE_PODCAST_NO_FITTING_CANDIDATE",
  );
  assert.equal(shadow.reserve.podcastCount, 0);
  assert.equal(shadow.reserve.musicCount, 1);
  assert.equal(shadow.reserve.selectedItems[0]?.uri, "spotify:track:fill");
});

test("PRIMARY shortfall and RESERVE shortfall remain independent diagnostics", () => {
  const playlistRules = rules({ targetDurationMs: 10 * MINUTE });
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [music("only-primary", 4)], podcasts: [] },
  });

  const shadow = projectDurationReserveShadow({
    targetPlaylistId: "target-1",
    targetName: "Shortfall",
    policy: durationPolicy({ minutes: 5 }),
    primary,
    rules: playlistRules,
    pools: { music: [music("only-primary", 4)], podcasts: [] },
  });

  assert.equal(shadow.primary.deficitMs, 6 * MINUTE);
  assert.equal(shadow.reserve.deficitMs, 5 * MINUTE);
  assert.equal(shadow.status, "SHORTFALL");
  assert.equal(shadow.primary.compositionQualityPassed, false);
});
