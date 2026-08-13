import assert from "node:assert/strict";
import test from "node:test";

import { planPlaylist } from "./planner";
import { planRun } from "./plan-run";
import type { Candidate, PlaylistRules } from "./types";

function podcast(
  uri: string,
  programId: string | undefined,
  durationMs = 60_000,
): Candidate {
  return {
    uri,
    type: "PODCAST",
    title: uri,
    programId,
    durationMs,
  };
}

function rules(
  targetDurationMs: number,
  maxEpisodesPerProgram = 1,
  maxPodcastDurationMs?: number | null,
): PlaylistRules {
  return {
    targetDurationMs,
    compositionMode: "PROPORTION",
    podcastPercent: 100,
    sequencePattern: ["PODCAST"],
    maxEpisodesPerProgram,
    maxPodcastDurationMs,
  };
}

test("#29 regression: missing programId cannot bypass the per-program cap", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:first", "show-a"),
        podcast("spotify:episode:bypass", undefined),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.uri, "spotify:episode:first");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
  assert.equal(result.stats.podcastShortfallMs, 60_000);
});

test("caps two episodes from the same show at one when maxEpisodesPerProgram is one", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-a"),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:episode:a"]);
});

test("allows episodes from different shows", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-b"),
      ],
    },
  });

  assert.equal(result.items.length, 2);
});

test("keeps URI deduplication when the same episode arrives more than once", () => {
  const result = planPlaylist({
    rules: rules(120_000, 2),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:same", "show-a"),
        podcast("spotify:episode:same", "show-a"),
        podcast("spotify:episode:other", "show-b"),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:episode:same",
    "spotify:episode:other",
  ]);
});

test("keeps a valid duplicate when another source copy is missing programId", () => {
  const result = planPlaylist({
    rules: rules(60_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:same", undefined),
        podcast("spotify:episode:same", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.uri, "spotify:episode:same");
  assert.equal(result.items[0]?.programId, "show-a");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
});

test("rejects blank program identities and normalizes surrounding whitespace", () => {
  const result = planPlaylist({
    rules: rules(60_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:blank", "   "),
        podcast("spotify:episode:valid", " show-b "),
      ],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.programId, "show-b");
  assert.equal(result.stats.podcastIdentityMissingCount, 1);
});

test("honors maxEpisodesPerProgram values greater than one", () => {
  const result = planPlaylist({
    rules: rules(180_000, 2),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:a", "show-a"),
        podcast("spotify:episode:b", "show-a"),
        podcast("spotify:episode:c", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 2);
});

test("shares the same show cap across candidates coming from different sources", () => {
  const result = planPlaylist({
    rules: rules(120_000, 1),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:saved", "show-a"),
        podcast("spotify:episode:show-source", "show-a"),
      ],
    },
  });

  assert.equal(result.items.length, 1);
});

test("#27 rejects podcast candidates whose effective duration exceeds the configured limit", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: rules(30 * minute, 1, 45 * minute),
    pools: {
      music: [],
      podcasts: [
        podcast("spotify:episode:too-long", "show-a", 50 * minute),
        podcast("spotify:episode:fits", "show-b", 30 * minute),
      ],
    },
  });

  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:episode:fits"]);
  assert.equal(result.stats.podcastDurationExceededCount, 1);
  assert.equal(result.stats.podcastShortfallMs, 0);
});

test("#27 compares the limit with remaining listening time, not catalog duration", () => {
  const minute = 60_000;
  const partiallyPlayed: Candidate = {
    ...podcast("spotify:episode:partial", "show-a", 30 * minute),
    originalDurationMs: 120 * minute,
    resumePositionMs: 90 * minute,
    playbackPositionKnown: true,
  };

  const result = planPlaylist({
    rules: rules(30 * minute, 1, 45 * minute),
    pools: { music: [], podcasts: [partiallyPlayed] },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.durationMs, 30 * minute);
  assert.equal(result.stats.podcastDurationExceededCount, 0);
});

test("#27 preserves current behavior when no podcast duration limit is configured", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: rules(60 * minute, 1, null),
    pools: {
      music: [],
      podcasts: [podcast("spotify:episode:long", "show-a", 60 * minute)],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.stats.podcastDurationExceededCount, 0);
});


function music(uri: string, durationMs = 60_000): Candidate {
  return { uri, type: "MUSIC", title: uri, durationMs };
}

test("#31 PROPORTION ignores the stored sequence as a physical rule", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "PROPORTION",
      targetDurationMs: 20 * minute,
      podcastPercent: 50,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("spotify:track:a", 5 * minute), music("spotify:track:b", 5 * minute)],
      podcasts: [podcast("spotify:episode:a", "show-a", 10 * minute)],
    },
  });
  assert.equal(result.items.some((item) => item.type === "PODCAST"), true);
  assert.equal(result.stats.compositionMode, "PROPORTION");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE repeats a simple cycle without substituting slot types", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 38 * minute,
      podcastPercent: 60,
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("m1", 4 * minute), music("m2", 4 * minute)],
      podcasts: [podcast("p1", "s1", 30 * minute)],
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC", "MUSIC", "PODCAST"]);
  assert.equal(result.stats.completedCycles, 1);
  assert.equal(result.stats.sequenceQualityPassed, true);
  assert.equal(result.stats.actualPodcastPercent > 70, true);
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE repeats a complex cycle exactly", () => {
  const pattern = ["MUSIC", "MUSIC", "PODCAST", "PODCAST", "MUSIC", "MUSIC", "PODCAST"] as const;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 14 * 60_000,
      podcastPercent: 50,
      sequencePattern: [...pattern],
      maxEpisodesPerProgram: 20,
    },
    pools: {
      music: Array.from({ length: 8 }, (_, i) => music(`m${i}`, 60_000)),
      podcasts: Array.from({ length: 6 }, (_, i) => podcast(`p${i}`, `s${i}`, 60_000)),
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), [...pattern, ...pattern]);
  assert.equal(result.stats.completedCycles, 2);
});

test("#31 SEQUENCE stops instead of replacing a missing MUSIC slot with PODCAST", () => {
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 180_000,
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: {
      music: [music("m1")],
      podcasts: [podcast("p1", "s1"), podcast("p2", "s2")],
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC"]);
  assert.equal(result.stats.sequenceUnfilledSlots, 1);
  assert.equal(result.stats.stoppedAtPatternIndex, 1);
  assert.equal(result.stats.sequenceStopReason, "NO_CANDIDATE_FOR_SLOT");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE ends early when the next same-type item cannot fit", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 6 * minute,
      podcastPercent: 100,
      sequencePattern: ["PODCAST"],
      maxEpisodesPerProgram: 10,
    },
    pools: { music: [], podcasts: [podcast("p-long", "s-long", 20 * minute)] },
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.stats.sequenceStopReason, "NO_FITTING_CANDIDATE");
  assert.equal(result.stats.compositionQualityPassed, true);
});

test("#31 SEQUENCE preserves #27 duration eligibility and #29 program cap", () => {
  const minute = 60_000;
  const result = planPlaylist({
    rules: {
      compositionMode: "SEQUENCE",
      targetDurationMs: 20 * minute,
      podcastPercent: 100,
      sequencePattern: ["PODCAST", "PODCAST"],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: 10 * minute,
    },
    pools: {
      music: [],
      podcasts: [
        podcast("too-long", "show-long", 15 * minute),
        podcast("a1", "show-a", 10 * minute),
        podcast("a2", "show-a", 10 * minute),
        podcast("b1", "show-b", 10 * minute),
      ],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), ["a1", "b1"]);
  assert.equal(result.stats.podcastDurationExceededCount, 1);
  assert.equal(result.stats.completedCycles, 1);
});


function diverseMusic(
  uri: string,
  primaryArtistId: string | undefined,
  albumId: string | undefined,
  durationMs = 60_000,
  names: { artist?: string; album?: string } = {},
): Candidate {
  return {
    uri,
    type: "MUSIC",
    title: uri,
    spotifyTrackId: uri.replace(/^spotify:track:/, ""),
    ...(primaryArtistId ? { primaryArtistId } : {}),
    ...(albumId ? { albumId } : {}),
    ...(names.artist ? { primaryArtistName: names.artist } : {}),
    ...(names.album ? { albumName: names.album } : {}),
    durationMs,
  };
}

function diversityRules(
  targetDurationMs: number,
  maxTracksPerArtist: number | null = null,
  maxTracksPerAlbum: number | null = null,
): PlaylistRules {
  return {
    targetDurationMs,
    compositionMode: "SEQUENCE",
    podcastPercent: 0,
    sequencePattern: ["MUSIC"],
    maxEpisodesPerProgram: 10,
    maxTracksPerArtist,
    maxTracksPerAlbum,
  };
}

test("#37 no diversity rules preserves current music selection behavior", () => {
  const result = planPlaylist({
    rules: diversityRules(120_000),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a"),
      ],
      podcasts: [],
    },
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.stats.artistLimitRejectedCount, 0);
  assert.equal(result.stats.albumLimitRejectedCount, 0);
});

test("#37 one track per primary artist never repeats that artist", () => {
  const result = planPlaylist({
    rules: diversityRules(120_000, 1, null),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a1"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a2"),
        diverseMusic("spotify:track:b1", "artist-b", "album-b1"),
      ],
      podcasts: [],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:track:a1",
    "spotify:track:b1",
  ]);
  assert.equal(result.stats.distinctArtistCount, 2);
  assert.equal(result.stats.artistLimitRejectedCount, 1);
});

test("#37 two tracks per artist reject the third even when it is from another album", () => {
  const result = planPlaylist({
    rules: diversityRules(180_000, 2, null),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a1"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a2"),
        diverseMusic("spotify:track:a3", "artist-a", "album-a3"),
        diverseMusic("spotify:track:b1", "artist-b", "album-b1"),
      ],
      podcasts: [],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:track:a1",
    "spotify:track:a2",
    "spotify:track:b1",
  ]);
  assert.equal(result.stats.artistLimitRejectedCount, 1);
});

test("#37 one track per album rejects the second track from the same album", () => {
  const result = planPlaylist({
    rules: diversityRules(120_000, null, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-x"),
        diverseMusic("spotify:track:b1", "artist-b", "album-x"),
        diverseMusic("spotify:track:c1", "artist-c", "album-y"),
      ],
      podcasts: [],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:track:a1",
    "spotify:track:c1",
  ]);
  assert.equal(result.stats.distinctAlbumCount, 2);
  assert.equal(result.stats.albumLimitRejectedCount, 1);
});

test("#37 combined 2-per-artist plus 1-per-album permits the same artist from different albums", () => {
  const result = planPlaylist({
    rules: diversityRules(120_000, 2, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-x"),
        diverseMusic("spotify:track:a2-same-album", "artist-a", "album-x"),
        diverseMusic("spotify:track:a3", "artist-a", "album-y"),
      ],
      podcasts: [],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), [
    "spotify:track:a1",
    "spotify:track:a3",
  ]);
  assert.equal(result.stats.albumLimitRejectedCount, 1);
  assert.equal(result.stats.artistLimitRejectedCount, 0);
});

test("#37 album and artist limits are independent and can reject the same scan deterministically", () => {
  const albumFirst = planPlaylist({
    rules: diversityRules(120_000, 2, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-x"),
        diverseMusic("spotify:track:a2", "artist-a", "album-x"),
        diverseMusic("spotify:track:a3", "artist-a", "album-y"),
      ],
      podcasts: [],
    },
  });
  assert.equal(albumFirst.stats.albumLimitRejectedCount, 1);

  const artistFirst = planPlaylist({
    rules: diversityRules(120_000, 1, 5),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-x"),
        diverseMusic("spotify:track:a2", "artist-a", "album-y"),
        diverseMusic("spotify:track:b1", "artist-b", "album-z"),
      ],
      podcasts: [],
    },
  });
  assert.equal(artistFirst.stats.artistLimitRejectedCount, 1);
  assert.equal(artistFirst.stats.albumLimitRejectedCount, 0);
});

test("#37 same artist/album names with different Spotify ids are not grouped by text", () => {
  const result = planPlaylist({
    rules: diversityRules(120_000, 1, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:a", "artist-id-a", "album-id-a", 60_000, {
          artist: "Same Name",
          album: "Same Album",
        }),
        diverseMusic("spotify:track:b", "artist-id-b", "album-id-b", 60_000, {
          artist: "Same Name",
          album: "Same Album",
        }),
      ],
      podcasts: [],
    },
  });
  assert.equal(result.items.length, 2);
  assert.equal(result.stats.distinctArtistCount, 2);
  assert.equal(result.stats.distinctAlbumCount, 2);
});

test("#37 missing Spotify identity is rejected safely when the corresponding rule is active", () => {
  const result = planPlaylist({
    rules: diversityRules(60_000, 1, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:no-artist", undefined, "album-a"),
        diverseMusic("spotify:track:no-album", "artist-b", undefined),
        diverseMusic("spotify:track:valid", "artist-c", "album-c"),
      ],
      podcasts: [],
    },
  });
  assert.deepEqual(result.items.map((item) => item.uri), ["spotify:track:valid"]);
  assert.equal(result.stats.missingArtistIdentityRejectedCount, 1);
  assert.equal(result.stats.missingAlbumIdentityRejectedCount, 1);
});

test("#37 a URI reserved by a higher-priority target does not consume artist/album quota in the next target", () => {
  const pools = {
    music: [
      diverseMusic("spotify:track:reserved", "artist-a", "album-a"),
      diverseMusic("spotify:track:available", "artist-a", "album-b"),
    ],
    podcasts: [],
  };
  const result = planRun({
    pools,
    targets: [
      {
        targetPlaylistId: "first",
        name: "First",
        priority: 0,
        rules: diversityRules(60_000, null, null),
      },
      {
        targetPlaylistId: "second",
        name: "Second",
        priority: 1,
        rules: diversityRules(60_000, 1, 1),
      },
    ],
  });
  assert.deepEqual(
    result.targets[1]?.result.items.map((item) => item.uri),
    ["spotify:track:available"],
  );
  assert.equal(result.targets[1]?.result.stats.artistLimitRejectedCount, 0);
});

test("#37 SEQUENCE does not break the slot type to bypass music diversity", () => {
  const result = planPlaylist({
    rules: {
      ...diversityRules(180_000, 1, null),
      sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
      podcastPercent: 50,
    },
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a1"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a2"),
      ],
      podcasts: [podcast("spotify:episode:p1", "show-p")],
    },
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC"]);
  assert.equal(result.stats.sequenceStopReason, "NO_CANDIDATE_FOR_SLOT");
  assert.equal(result.stats.artistLimitRejectedCount, 1);
});

test("#37 PROPORTION exposes shortfall when diversity exhausts eligible music", () => {
  const result = planPlaylist({
    rules: {
      targetDurationMs: 120_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 10,
      maxTracksPerArtist: 1,
      maxTracksPerAlbum: null,
    },
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a1"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a2"),
      ],
      podcasts: [],
    },
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.stats.poolExhausted, true);
  assert.equal(result.stats.musicShortfallMs, 60_000);
  assert.equal(result.stats.artistLimitRejectedCount, 1);
  assert.equal(result.stats.compositionQualityPassed, false);
});

test("#37 rejection counters stay deterministic when the planner scans the same blocked candidate repeatedly", () => {
  const result = planPlaylist({
    rules: diversityRules(180_000, 1, 1),
    pools: {
      music: [
        diverseMusic("spotify:track:a1", "artist-a", "album-a"),
        diverseMusic("spotify:track:a2", "artist-a", "album-a"),
      ],
      podcasts: [],
    },
  });
  assert.equal(result.stats.artistLimitRejectedCount, 1);
  assert.equal(result.stats.albumLimitRejectedCount, 1);
});


test("#58 KEEP_FILLED starts from preserved valid content and fills only the deficit", () => {
  const preserved = music("preserved", 180_000);
  const pools = {
    music: [music("new-1", 180_000), music("new-2", 180_000)],
    podcasts: [],
  };
  const result = planPlaylist({
    rules: {
      targetDurationMs: 540_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },
    pools,
    preserved: [preserved],
  });
  assert.equal(result.items[0]?.uri, preserved.uri);
  assert.equal(result.items.length, 3);
  assert.equal(result.stats.totalDurationMs, 540_000);
  assert.equal(result.items.filter((item) => item.uri === preserved.uri).length, 1);
});

test("#58 KEEP_FILLED sequence resumes from the slot after the preserved prefix", () => {
  const preservedMusic = music("preserved-sequence", 180_000);
  const nextPodcast = podcast("next-podcast", "program-next", 180_000);
  const result = planPlaylist({
    rules: {
      targetDurationMs: 360_000,
      compositionMode: "SEQUENCE",
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 1,
    },
    pools: { music: [], podcasts: [nextPodcast] },
    preserved: [preservedMusic],
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC", "PODCAST"]);
  assert.equal(result.items[0]?.uri, preservedMusic.uri);
});

test("#92 KEEP_FILLED SEQUENCE realigns preserved items after exclusivity removes one", () => {
  const music = (id: string): Candidate => ({
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    durationMs: 300_000,
    spotifyTrackId: id,
  });
  const episode = (id: string): Candidate => ({
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    durationMs: 300_000,
    programId: `show:${id}`,
  });
  const sequenceRules: PlaylistRules = {
    targetDurationMs: 900_000,
    compositionMode: "SEQUENCE",
    podcastPercent: 33,
    sequencePattern: ["MUSIC", "MUSIC", "PODCAST"],
    maxEpisodesPerProgram: 10,
  };
  const result = planPlaylist({
    rules: sequenceRules,
    pools: { music: [], podcasts: [] },
    reserved: ["spotify:track:m2"],
    preserved: [
      music("m1"),
      music("m2"),
      episode("p1"),
      music("m3"),
      music("m4"),
      episode("p2"),
    ],
  });

  assert.deepEqual(
    result.items.map((item) => item.type),
    ["MUSIC", "MUSIC", "PODCAST"],
  );
  assert.deepEqual(
    result.items.map((item) => item.uri),
    ["spotify:track:m1", "spotify:track:m3", "spotify:episode:p2"],
  );
  assert.equal(result.stats.compositionQualityPassed, true);
});
