import assert from "node:assert/strict";
import test from "node:test";

import type { EffectivePlaybackReservePolicySnapshot } from "@/services/playback-reserve-policy";

import { projectCalendar03EventComposition } from "./calendar-event-composition-shadow";
import { planPlaylist } from "./planner";
import { projectDurationReserveShadow } from "./playback-reserve-duration-shadow";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;

function music(id: string, minutes: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    albumId: `album-${id}`,
    durationMs: minutes * MINUTE,
  };
}

function podcast(
  id: string,
  effectiveMinutes: number,
  options: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: effectiveMinutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
    ...options,
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

function durationPolicy(minutes: number): EffectivePlaybackReservePolicySnapshot {
  return {
    targetPlaylistId: "target",
    source: "GLOBAL",
    reserveMode: "DURATION",
    durationSeconds: minutes * 60,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "IF_FITS",
  };
}

test("Gate 5 reserve and CALENDAR-03 choose the same first fitting podcast", () => {
  const playlistRules = rules({ maxEpisodesPerProgram: 2 });
  const primaryMusic = music("primary", 4);
  const podcasts = [
    podcast("priority-18", 18),
    podcast("later-best-fit-29", 29),
  ];

  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [primaryMusic], podcasts: [] },
  });
  const reserve = projectDurationReserveShadow({
    targetPlaylistId: "target",
    targetName: "Carro",
    policy: durationPolicy(30),
    primary,
    rules: playlistRules,
    pools: {
      music: [primaryMusic, music("fill-12", 12)],
      podcasts,
    },
  });

  const calendar = projectCalendar03EventComposition({
    policy: {
      targetPlaylistId: "target",
      eventCompositionPolicy: "PODCAST_THEN_MUSIC",
      maxPodcastsPerEvent: 1,
      podcastEventSafetyMarginSeconds: 0,
      podcastEventDistribution: "EVERY_EVENT",
      podcastEveryNEvents: 1,
      podcastEventOffset: 0,
    },
    blocks: [{ key: "window", targetDurationMs: 30 * MINUTE }],
    rules: playlistRules,
    pools: {
      music: [music("calendar-fill-12", 12)],
      podcasts,
    },
  });

  const reservePodcast = reserve.reserve.selectedItems.find(
    (item) => item.type === "PODCAST",
  );
  assert.equal(reservePodcast?.uri, "spotify:episode:priority-18");
  assert.deepEqual(calendar.blocks[0]?.selectedPodcastUris, [reservePodcast?.uri]);
});

test("Gate 5 DURATION + IF_FITS accepts an IN_PROGRESS episode by remaining duration", () => {
  const playlistRules = rules();
  const primaryMusic = music("primary", 4);
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [primaryMusic], podcasts: [] },
  });

  const resumed = podcast("resume", 12, {
    originalDurationMs: 40 * MINUTE,
    resumePositionMs: 28 * MINUTE,
    playbackPositionKnown: true,
    podcastListeningStatus: "IN_PROGRESS",
  });

  const reserve = projectDurationReserveShadow({
    targetPlaylistId: "target",
    targetName: "Carro",
    policy: durationPolicy(15),
    primary,
    rules: playlistRules,
    pools: {
      music: [primaryMusic, music("fill-3", 3)],
      podcasts: [resumed],
    },
  });

  assert.equal(reserve.reserve.podcastDecision, "RESERVE_PODCAST_SELECTED");
  assert.equal(reserve.reserve.podcastCount, 1);
  assert.equal(
    reserve.reserve.selectedItems.find((item) => item.type === "PODCAST")?.uri,
    "spotify:episode:resume",
  );
  assert.equal(
    reserve.reserve.selectedItems.find((item) => item.type === "PODCAST")?.durationMs,
    12 * MINUTE,
  );
  assert.equal(reserve.reserve.plannedDurationMs, 15 * MINUTE);
  assert.equal(reserve.reserve.deficitMs, 0);
});

test("Gate 5 no fitting podcast remains non-error and DURATION fills with music", () => {
  const playlistRules = rules({ maxEpisodesPerProgram: 2 });
  const primaryMusic = music("primary", 4);
  const primary = planPlaylist({
    rules: playlistRules,
    pools: { music: [primaryMusic], podcasts: [] },
  });

  const reserve = projectDurationReserveShadow({
    targetPlaylistId: "target",
    targetName: "Carro",
    policy: durationPolicy(15),
    primary,
    rules: playlistRules,
    pools: {
      music: [primaryMusic, music("fill-15", 15)],
      podcasts: [podcast("too-long", 20)],
    },
  });

  assert.equal(
    reserve.reserve.podcastDecision,
    "RESERVE_PODCAST_NO_FITTING_CANDIDATE",
  );
  assert.equal(reserve.reserve.podcastCount, 0);
  assert.equal(reserve.reserve.musicCount, 1);
  assert.deepEqual(
    reserve.reserve.selectedItems.map((item) => item.uri),
    ["spotify:track:fill-15"],
  );
});
