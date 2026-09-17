import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPlaybackReservePolicyLabel,
  parsePlaybackReservePolicyForm,
  parseTargetPlaybackReservePolicyForm,
  type PlaybackReserveFormReader,
} from "./playback-reserve-ui";

function form(values: Record<string, string>): PlaybackReserveFormReader {
  return {
    get(name: string) {
      return values[name] ?? null;
    },
  };
}

test("Gate 9 parses all global reserve modes", () => {
  assert.deepEqual(
    parsePlaybackReservePolicyForm(form({ reserveMode: "NONE" })),
    { reserveMode: "NONE" },
  );

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

test("Gate 9 supports target inherit and explicit NONE override", () => {
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

test("Gate 9 ignores fields that do not belong to the selected mode", () => {
  assert.deepEqual(
    parsePlaybackReservePolicyForm(
      form({
        reserveMode: "MUSIC_TRACKS",
        durationMinutes: "30",
        musicTrackCount: "4",
        podcastEpisodeCount: "7",
        podcastInDurationReserve: "IF_FITS",
      }),
    ),
    { reserveMode: "MUSIC_TRACKS", musicTrackCount: 4 },
  );
});

test("Gate 9 rejects invalid positive values", () => {
  assert.throws(() =>
    parsePlaybackReservePolicyForm(
      form({ reserveMode: "DURATION", durationMinutes: "0" }),
    ),
  );
  assert.throws(() =>
    parsePlaybackReservePolicyForm(
      form({ reserveMode: "MUSIC_TRACKS", musicTrackCount: "1.5" }),
    ),
  );
  assert.throws(() =>
    parseTargetPlaybackReservePolicyForm(
      form({ policyMode: "SOMETHING", reserveMode: "NONE" }),
    ),
  );
});

test("Gate 9 formats the current effective policy for the UI", () => {
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
  assert.equal(
    formatPlaybackReservePolicyLabel({
      reserveMode: "MUSIC_TRACKS",
      durationSeconds: null,
      musicTrackCount: 1,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "DISABLED",
    }),
    "+1 música",
  );
});
