import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultPlaybackReservePolicy,
  defaultTargetPlaybackReservePolicy,
  normalizeGenerationPlanRole,
  normalizePlaybackReservePolicy,
  normalizeTargetPlaybackReservePolicy,
  playbackReserveFingerprintFragment,
  resolveEffectivePlaybackReservePolicy,
} from "./playback-reserve-policy";
import {
  formatPlaybackReservePolicyLabel,
  parsePlaybackReservePolicyForm,
  parseTargetPlaybackReservePolicyForm,
  type PlaybackReserveFormReader,
} from "./playback-reserve-ui";

test("PLAYBACK-RESERVE-01 defaults are backward-compatible", () => {
  assert.deepEqual(defaultPlaybackReservePolicy(), {
    reserveMode: "NONE",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  });

  assert.deepEqual(defaultTargetPlaybackReservePolicy("target-1"), {
    targetPlaylistId: "target-1",
    policyMode: "INHERIT_GLOBAL",
    reserveMode: null,
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: null,
  });

  assert.equal(normalizeGenerationPlanRole(undefined), "PRIMARY");
  assert.equal(normalizeGenerationPlanRole(null), "PRIMARY");
});

test("DURATION accepts a positive budget and optional podcast IF_FITS", () => {
  assert.deepEqual(
    normalizePlaybackReservePolicy({
      reserveMode: "DURATION",
      durationSeconds: 900,
      podcastInDurationReserve: "IF_FITS",
    }),
    {
      reserveMode: "DURATION",
      durationSeconds: 900,
      musicTrackCount: null,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "IF_FITS",
    },
  );

  assert.deepEqual(
    normalizePlaybackReservePolicy({
      reserveMode: "DURATION",
      durationSeconds: 1800,
    }),
    {
      reserveMode: "DURATION",
      durationSeconds: 1800,
      musicTrackCount: null,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED",
    },
  );
});

test("MUSIC_TRACKS and PODCAST_EPISODES preserve only their active quantity", () => {
  assert.deepEqual(
    normalizePlaybackReservePolicy({
      reserveMode: "MUSIC_TRACKS",
      musicTrackCount: 5,
    }),
    {
      reserveMode: "MUSIC_TRACKS",
      durationSeconds: null,
      musicTrackCount: 5,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED",
    },
  );

  assert.deepEqual(
    normalizePlaybackReservePolicy({
      reserveMode: "PODCAST_EPISODES",
      podcastEpisodeCount: 1,
    }),
    {
      reserveMode: "PODCAST_EPISODES",
      durationSeconds: null,
      musicTrackCount: null,
      podcastEpisodeCount: 1,
      podcastInDurationReserve: "DISABLED",
    },
  );
});

test("contract rejects zero/negative budgets and cross-mode fields", () => {
  for (const durationSeconds of [0, -1, 1.5]) {
    assert.throws(
      () =>
        normalizePlaybackReservePolicy({
          reserveMode: "DURATION",
          durationSeconds,
        }),
      /durationSeconds must be a positive integer/,
    );
  }

  assert.throws(
    () =>
      normalizePlaybackReservePolicy({
        reserveMode: "NONE",
        durationSeconds: 900,
      }),
    /durationSeconds must be absent for reserveMode NONE/,
  );

  assert.throws(
    () =>
      normalizePlaybackReservePolicy({
        reserveMode: "MUSIC_TRACKS",
        musicTrackCount: 5,
        podcastInDurationReserve: "IF_FITS",
      }),
    /podcastInDurationReserve must be DISABLED for reserveMode MUSIC_TRACKS/,
  );

  assert.throws(
    () =>
      normalizePlaybackReservePolicy({
        reserveMode: "PODCAST_EPISODES",
        podcastEpisodeCount: 1,
        musicTrackCount: 1,
      }),
    /musicTrackCount must be absent for reserveMode PODCAST_EPISODES/,
  );
});

test("target INHERIT_GLOBAL has no hidden override state", () => {
  assert.throws(
    () =>
      normalizeTargetPlaybackReservePolicy("target-1", {
        policyMode: "INHERIT_GLOBAL",
        reserveMode: "NONE",
      }),
    /reserveMode must be absent when policyMode is INHERIT_GLOBAL/,
  );
});

test("target OVERRIDE can explicitly disable a global reserve", () => {
  const target = normalizeTargetPlaybackReservePolicy("target-1", {
    policyMode: "OVERRIDE",
    reserveMode: "NONE",
  });

  assert.deepEqual(target, {
    targetPlaylistId: "target-1",
    policyMode: "OVERRIDE",
    reserveMode: "NONE",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  });

  const effective = resolveEffectivePlaybackReservePolicy(
    "target-1",
    normalizePlaybackReservePolicy({
      reserveMode: "DURATION",
      durationSeconds: 900,
      podcastInDurationReserve: "IF_FITS",
    }),
    target,
  );

  assert.deepEqual(effective, {
    targetPlaylistId: "target-1",
    source: "TARGET_OVERRIDE",
    reserveMode: "NONE",
    durationSeconds: null,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "DISABLED",
  });
});

test("target without override resolves the global policy", () => {
  const globalPolicy = normalizePlaybackReservePolicy({
    reserveMode: "MUSIC_TRACKS",
    musicTrackCount: 4,
  });

  assert.deepEqual(
    resolveEffectivePlaybackReservePolicy(
      "target-1",
      globalPolicy,
      defaultTargetPlaybackReservePolicy("target-1"),
    ),
    {
      targetPlaylistId: "target-1",
      source: "GLOBAL",
      reserveMode: "MUSIC_TRACKS",
      durationSeconds: null,
      musicTrackCount: 4,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED",
    },
  );
});

test("fingerprint fragment is semantic and does not encode inheritance source", () => {
  const globalPolicy = normalizePlaybackReservePolicy({
    reserveMode: "DURATION",
    durationSeconds: 900,
    podcastInDurationReserve: "IF_FITS",
  });
  const effective = resolveEffectivePlaybackReservePolicy(
    "target-1",
    globalPolicy,
    defaultTargetPlaybackReservePolicy("target-1"),
  );

  assert.deepEqual(
    playbackReserveFingerprintFragment(globalPolicy),
    playbackReserveFingerprintFragment(effective),
  );
  assert.deepEqual(playbackReserveFingerprintFragment(effective), {
    reserveMode: "DURATION",
    durationSeconds: 900,
    musicTrackCount: null,
    podcastEpisodeCount: null,
    podcastInDurationReserve: "IF_FITS",
  });
});

test("generation plan role accepts only PRIMARY/RESERVE and defaults to PRIMARY", () => {
  assert.equal(normalizeGenerationPlanRole("PRIMARY"), "PRIMARY");
  assert.equal(normalizeGenerationPlanRole("RESERVE"), "RESERVE");
  assert.throws(
    () => normalizeGenerationPlanRole("OTHER" as never),
    /must be PRIMARY or RESERVE/,
  );
});

function form(values: Record<string, string>): PlaybackReserveFormReader {
  return {
    get(name: string) {
      return values[name] ?? null;
    },
  };
}

test("Gate 9 UI maps global forms to the canonical policy contract", () => {
  assert.deepEqual(
    parsePlaybackReservePolicyForm(
      form({
        reserveMode: "DURATION",
        durationMinutes: "15",
        podcastInDurationReserve: "IF_FITS",
      }),
    ),
    {
      reserveMode: "DURATION",
      durationSeconds: 900,
      podcastInDurationReserve: "IF_FITS",
    },
  );
  assert.deepEqual(
    parsePlaybackReservePolicyForm(
      form({ reserveMode: "MUSIC_TRACKS", musicTrackCount: "5" }),
    ),
    { reserveMode: "MUSIC_TRACKS", musicTrackCount: 5 },
  );
  assert.deepEqual(
    parsePlaybackReservePolicyForm(
      form({ reserveMode: "PODCAST_EPISODES", podcastEpisodeCount: "2" }),
    ),
    { reserveMode: "PODCAST_EPISODES", podcastEpisodeCount: 2 },
  );
});

test("Gate 9 UI preserves inherit and explicit NONE override semantics", () => {
  assert.deepEqual(
    parseTargetPlaybackReservePolicyForm(
      form({ policyMode: "INHERIT_GLOBAL", reserveMode: "DURATION" }),
    ),
    { policyMode: "INHERIT_GLOBAL" },
  );
  assert.deepEqual(
    parseTargetPlaybackReservePolicyForm(
      form({ policyMode: "OVERRIDE", reserveMode: "NONE" }),
    ),
    { policyMode: "OVERRIDE", reserveMode: "NONE" },
  );
});

test("Gate 9 UI validates active values and exposes a compact effective label", () => {
  assert.throws(() =>
    parsePlaybackReservePolicyForm(
      form({ reserveMode: "MUSIC_TRACKS", musicTrackCount: "1.5" }),
    ),
  );
  assert.equal(
    formatPlaybackReservePolicyLabel({
      reserveMode: "DURATION",
      durationSeconds: 900,
      musicTrackCount: null,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "IF_FITS",
    }),
    "+15 min · podcast se couber",
  );
});
