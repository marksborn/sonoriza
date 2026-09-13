import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";

import {
  podcast07ConfigurationFingerprint,
  type Podcast07FingerprintSnapshot,
} from "./podcast-07-generation-configuration";
import { applyPodcastShowPolicy } from "./podcast-show-policy";
import type { PodcastShowPolicySnapshot } from "./podcast-show-policy-store";

function episode(
  id: string,
  releaseDate: string,
  status: Candidate["podcastListeningStatus"] = "NOT_STARTED",
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    spotifyEpisodeId: id,
    type: "PODCAST",
    title: id,
    programId: "show-a",
    durationMs: 60_000,
    releaseDate,
    releaseDatePrecision: "day",
    podcastListeningStatus: status,
    ...overrides,
  };
}

function policy(
  overrides: Partial<PodcastShowPolicySnapshot & { publishedEpisodeIds: string[] }> = {},
): PodcastShowPolicySnapshot & { publishedEpisodeIds: string[] } {
  return {
    sourcePlaylistId: "source-a",
    episodeEligibility: "UNPLAYED_ONLY",
    episodeOrder: "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: 1,
    sequenceCursorEpisodeId: null,
    sequenceCompleted: false,
    randomRound: 0,
    randomConsumedEpisodeIds: [],
    publishedEpisodeIds: [],
    ...overrides,
  };
}

test("UNPLAYED_ONLY + OLDEST_FIRST uses show catalog without saved-episode membership", () => {
  const result = applyPodcastShowPolicy([
    episode("3", "2026-08-03"),
    episode("1", "2026-08-01", "COMPLETED"),
    episode("2", "2026-08-02", "IN_PROGRESS"),
  ], policy());

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["2", "3"]);
  assert.equal(result.stateFilteredCount, 1);
  assert.equal(result.candidates[0]?.sourceIncludePlayed, false);
});

test("NEWEST_FIRST reverses deterministic show traversal", () => {
  const result = applyPodcastShowPolicy([
    episode("1", "2026-08-01"),
    episode("2", "2026-08-02"),
    episode("3", "2026-08-03"),
  ], policy({ episodeOrder: "NEWEST_FIRST", strictSequence: false }));

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["3", "2", "1"]);
});

test("PLAYED_ONLY replay advances after the last real published episode", () => {
  const result = applyPodcastShowPolicy([
    episode("1", "2026-08-01", "COMPLETED"),
    episode("2", "2026-08-02", "COMPLETED"),
    episode("3", "2026-08-03", "COMPLETED"),
  ], policy({
    episodeEligibility: "PLAYED_ONLY",
    startEpisodeId: "1",
    publishedEpisodeIds: ["1"],
  }));

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["2", "3"]);
  assert.equal(result.candidates[0]?.podcastSequenceStateful, true);
});

test("RANDOM without replacement excludes already published episodes until the round is exhausted", () => {
  const candidates = [
    episode("1", "2026-08-01", "COMPLETED"),
    episode("2", "2026-08-02", "COMPLETED"),
    episode("3", "2026-08-03", "COMPLETED"),
  ];
  const result = applyPodcastShowPolicy(candidates, policy({
    episodeEligibility: "PLAYED_ONLY",
    episodeOrder: "RANDOM",
    randomPolicy: "WITHOUT_REPLACEMENT",
    publishedEpisodeIds: ["1", "2"],
  }));

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["3"]);
  assert.equal(result.randomConsumedSkippedCount, 2);
});

test("RANDOM without replacement opens a new round after every eligible episode was published", () => {
  const candidates = [
    episode("1", "2026-08-01", "COMPLETED"),
    episode("2", "2026-08-02", "COMPLETED"),
  ];
  const result = applyPodcastShowPolicy(candidates, policy({
    episodeEligibility: "PLAYED_ONLY",
    episodeOrder: "RANDOM",
    randomPolicy: "WITHOUT_REPLACEMENT",
    publishedEpisodeIds: ["1", "2"],
  }));

  assert.equal(result.candidates.length, 2);
  assert.equal(result.effectiveRandomRound, 1);
  assert.equal(result.randomRoundReset, true);
});

test("RANDOM with replacement keeps previously published episodes eligible", () => {
  const candidates = [
    episode("1", "2026-08-01", "COMPLETED"),
    episode("2", "2026-08-02", "COMPLETED"),
  ];
  const result = applyPodcastShowPolicy(candidates, policy({
    episodeEligibility: "PLAYED_ONLY",
    episodeOrder: "RANDOM",
    randomPolicy: "WITH_REPLACEMENT",
    publishedEpisodeIds: ["1", "1", "2"],
  }));

  assert.equal(result.candidates.length, 2);
  assert.deepEqual(new Set(result.candidates.map((item) => item.spotifyEpisodeId)), new Set(["1", "2"]));
});

test("release window expires stale news even when it remains unplayed", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const result = applyPodcastShowPolicy([
    episode("old", "2026-08-20"),
    episode("fresh", "2026-08-27"),
  ], policy({ maxReleaseAgeDays: 2 }), now);

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["fresh"]);
  assert.equal(result.releaseExpiredCount, 1);
});

test("ALLOW_IN_PROGRESS_TO_FINISH only keeps stale progress first observed while episode was fresh", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const result = applyPodcastShowPolicy([
    episode("started-in-time", "2026-08-20", "IN_PROGRESS", {
      podcastFirstProgressObservedAt: new Date("2026-08-21T10:00:00.000Z"),
    }),
    episode("started-too-late", "2026-08-20", "IN_PROGRESS", {
      podcastFirstProgressObservedAt: new Date("2026-08-25T10:00:00.000Z"),
    }),
  ], policy({
    maxReleaseAgeDays: 2,
    expiryPolicy: "ALLOW_IN_PROGRESS_TO_FINISH",
  }), now);

  assert.deepEqual(result.candidates.map((item) => item.spotifyEpisodeId), ["started-in-time"]);
  assert.equal(result.releaseExpiredCount, 1);
});

function podcast07FingerprintSnapshot(): Podcast07FingerprintSnapshot {
  return {
    savedEpisodes: [{
      spotifyId: "saved",
      enabled: true,
      episodeOrder: "RANDOM",
      randomPolicy: "WITHOUT_REPLACEMENT",
      cadenceMaxEpisodes: 1,
      cadenceUnit: "WEEK",
      frequencyScope: "PER_SHOW",
    }],
    shows: [{
      spotifyShowId: "show-a",
      authority: "SHOW_OVERRIDE",
      policy: {
        episodeEligibility: "UNPLAYED_ONLY",
        episodeOrder: "OLDEST_FIRST",
        randomPolicy: "WITHOUT_REPLACEMENT",
        showEpisodeScope: "ALL_EPISODES",
        startEpisodeId: null,
        strictSequence: true,
        maxReleaseAgeDays: null,
        expiryPolicy: "STRICT_EXPIRY",
        maxEpisodesPerCycle: null,
      },
    }],
  };
}

test("PODCAST-07 Gate 6 fingerprint changes for saved scope, cadence and order", () => {
  const base = podcast07FingerprintSnapshot();
  const original = podcast07ConfigurationFingerprint("base", base);
  const changes: Podcast07FingerprintSnapshot[] = [
    { ...base, savedEpisodes: [{ ...base.savedEpisodes[0]!, frequencyScope: "GLOBAL_POOL" }] },
    { ...base, savedEpisodes: [{ ...base.savedEpisodes[0]!, cadenceMaxEpisodes: 2 }] },
    { ...base, savedEpisodes: [{ ...base.savedEpisodes[0]!, episodeOrder: "OLDEST_FIRST" }] },
  ];
  for (const changed of changes) {
    assert.notEqual(podcast07ConfigurationFingerprint("base", changed), original);
  }
});

test("PODCAST-07 Gate 6 fingerprint distinguishes inherited SHOW from explicit override", () => {
  const base = podcast07FingerprintSnapshot();
  const inherited: Podcast07FingerprintSnapshot = {
    ...base,
    shows: [{
      spotifyShowId: "show-a",
      authority: "INHERIT_SAVED_EPISODES",
      policy: null,
    }],
  };
  assert.notEqual(
    podcast07ConfigurationFingerprint("base", inherited),
    podcast07ConfigurationFingerprint("base", base),
  );
});

test("PODCAST-07 Gate 6 fingerprint changes when SHOW episode scope changes", () => {
  const base = podcast07FingerprintSnapshot();
  const show = base.shows[0]!;
  assert.equal(show.authority, "SHOW_OVERRIDE");
  if (show.authority !== "SHOW_OVERRIDE" || !show.policy) return;
  const changed: Podcast07FingerprintSnapshot = {
    ...base,
    shows: [{ ...show, policy: { ...show.policy, showEpisodeScope: "SAVED_ONLY" } }],
  };
  assert.notEqual(
    podcast07ConfigurationFingerprint("base", changed),
    podcast07ConfigurationFingerprint("base", base),
  );
});

test("PODCAST-07 Gate 6 canonical UI exposes default policy, frequency scope and SHOW source scope", () => {
  const page = readFileSync("src/app/dashboard/configuracao/fontes/podcasts/page.tsx", "utf8");
  const client = readFileSync(
    "src/app/dashboard/configuracao/fontes/podcasts/podcast-policy-client.tsx",
    "utf8",
  );

  assert.match(page, /savePodcastSavedEpisodesPolicy/);
  assert.match(page, /hasExplicitPolicy: show\.podcastShowPolicy !== null/);
  assert.match(client, /Herda Seus episódios/);
  assert.match(client, /name="frequencyScope"/);
  assert.match(client, /value="GLOBAL_POOL"/);
  assert.match(client, /name="showEpisodeScope"/);
  assert.match(client, /value="ALL_EPISODES">Todos os episódios do programa/);
  assert.match(client, /value="SAVED_ONLY">Somente episódios salvos/);
});
