import assert from "node:assert/strict";
import test from "node:test";

import {
  COLD_START_GENRES,
  COLD_START_PODCAST_TOPICS,
  needsColdStart,
  normalizeColdStartPreferences,
  planPodcastFollow,
} from "./cold-start-contract";

test("#473: cold start is available when no eligible source exists, or by request", () => {
  assert.equal(needsColdStart({ eligibleSourceCount: 0 }), true);
  assert.equal(needsColdStart({ eligibleSourceCount: 2 }), false);
  assert.equal(needsColdStart({ eligibleSourceCount: 2, startFromZero: true }), true);
});

test("#473: localized genre/topic catalogs have unique stable identifiers", () => {
  for (const catalog of [COLD_START_GENRES, COLD_START_PODCAST_TOPICS]) {
    assert.equal(new Set(catalog.map((entry) => entry.id)).size, catalog.length);
  }
});

test("#473: user may start with podcasts only and without Last.fm/history", () => {
  assert.deepEqual(
    normalizeColdStartPreferences({
      content: "PODCAST",
      genreIds: ["rock"],
      podcastTopicIds: ["tecnologia", "tecnologia", "historia", "unknown"],
    }),
    {
      content: "PODCAST",
      genreIds: [],
      artistNames: [],
      podcastTopicIds: ["tecnologia", "historia"],
      podcastLanguage: "pt-BR",
    },
  );
});

test("#473: music seeds remain explicit and duplicate-safe", () => {
  const preference = normalizeColdStartPreferences({
    content: "MIXED",
    genreIds: ["rock", "mpb", "rock", "unrecognized"],
    artistNames: ["  Pitty ", "pitty", "Legião    Urbana"],
    podcastTopicIds: ["ciencia"],
  });
  assert.deepEqual(preference.genreIds, ["rock", "mpb"]);
  assert.deepEqual(preference.artistNames, ["Pitty", "Legião Urbana"]);
  assert.deepEqual(preference.podcastTopicIds, ["ciencia"]);
});

test("#473: a follow action requires explicit confirmation and valid show ID", () => {
  assert.throws(() => planPodcastFollow({
    spotifyShowId: "0123456789012345678901", mode: "SONORIZA_ONLY", confirmed: false,
  }));
  assert.throws(() => planPodcastFollow({
    spotifyShowId: "not-valid", mode: "SONORIZA_ONLY", confirmed: true,
  }));
});

test("#473: following on Sonoriza creates SHOW intent, not saved episodes", () => {
  assert.deepEqual(planPodcastFollow({
    spotifyShowId: "0123456789012345678901", mode: "SONORIZA_ONLY", confirmed: true,
  }), {
    spotifyShowId: "0123456789012345678901",
    source: { spotifyType: "SHOW", kind: "PODCAST" },
    followInSonoriza: true,
    followOnSpotify: false,
    spotifyLibraryUri: null,
    saveEpisodesToYourEpisodes: false,
  });
});

test("#473: Spotify follow is a separate consented library operation", () => {
  const plan = planPodcastFollow({
    spotifyShowId: "spotify:show:0123456789012345678901",
    mode: "SONORIZA_AND_SPOTIFY",
    confirmed: true,
  });
  assert.equal(plan.followOnSpotify, true);
  assert.equal(plan.spotifyLibraryUri, "spotify:show:0123456789012345678901");
  assert.equal(plan.saveEpisodesToYourEpisodes, false);
});
