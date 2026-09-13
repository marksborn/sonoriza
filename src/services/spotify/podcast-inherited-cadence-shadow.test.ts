import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePodcastEffectivePolicyShadow,
  type PodcastShowOverrideShadow,
} from "./podcast-effective-policy-shadow";
import type { Podcast07PoolShadowCandidate } from "./podcast-efficient-pool-shadow";
import { projectPodcast07InheritedPerShowCadenceShadow } from "./podcast-inherited-cadence-shadow";
import type { PodcastSavedEpisodesPolicySnapshot } from "./podcast-saved-episodes-policy-store";
import type { PodcastShowPolicyStoredSnapshot } from "./podcast-show-policy-store";

function savedPolicy(
  overrides: Partial<PodcastSavedEpisodesPolicySnapshot> = {},
): PodcastSavedEpisodesPolicySnapshot {
  return {
    sourcePlaylistId: "saved-source",
    enabled: true,
    episodeOrder: "RANDOM",
    randomPolicy: "WITHOUT_REPLACEMENT",
    cadenceMaxEpisodes: 1,
    cadenceUnit: "WEEK",
    frequencyScope: "PER_SHOW",
    ...overrides,
  };
}

function savedEpisode(id: string, showId: string, showName = showId) {
  return {
    spotifyEpisodeId: id,
    spotifyUri: `spotify:episode:${id}`,
    spotifyShowId: showId,
    showName,
  };
}

function defaultCandidate(id: string, showId: string): Podcast07PoolShadowCandidate {
  return {
    ...savedEpisode(id, showId),
    authority: "SAVED_EPISODES_DEFAULT",
    sourcePlaylistId: "saved-source",
    showEpisodeScope: null,
    origin: "SAVED_EPISODES",
  };
}

function showPolicy(
  sourcePlaylistId: string,
  scope: "ALL_EPISODES" | "SAVED_ONLY" = "SAVED_ONLY",
): PodcastShowPolicyStoredSnapshot {
  return {
    sourcePlaylistId,
    episodeEligibility: "UNPLAYED_ONLY",
    episodeOrder: "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    showEpisodeScope: scope,
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: null,
    randomRound: 0,
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
    priority: "NORMAL",
  };
}

function showOverride(showId: string): PodcastShowOverrideShadow {
  const sourcePlaylistId = `source-${showId}`;
  return {
    sourcePlaylistId,
    spotifyShowId: showId,
    showName: showId,
    showEpisodeScope: "SAVED_ONLY",
    policy: showPolicy(sourcePlaylistId),
  };
}

function overrideCandidate(id: string, showId: string): Podcast07PoolShadowCandidate {
  return {
    ...savedEpisode(id, showId),
    authority: "SHOW_OVERRIDE",
    sourcePlaylistId: `source-${showId}`,
    showEpisodeScope: "SAVED_ONLY",
    origin: "SAVED_EPISODES",
  };
}

function resolution(input: {
  policy?: PodcastSavedEpisodesPolicySnapshot | null;
  episodes: ReturnType<typeof savedEpisode>[];
  overrides?: PodcastShowOverrideShadow[];
}) {
  return resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: "saved-source",
    defaultPolicy: input.policy === undefined ? savedPolicy() : input.policy,
    showOverrides: input.overrides ?? [],
    savedEpisodes: input.episodes,
  });
}

const AS_OF = new Date("2026-09-10T15:00:00Z");
const TIME_ZONE = "America/Sao_Paulo";

test("Gate 4 applies inherited 1/WEEK independently to multiple default-governed shows", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a"), savedEpisode("b-next", "show-b")],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a"), defaultCandidate("b-next", "show-b")],
    listeningStates: [
      {
        spotifyEpisodeId: "a-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-08T12:00:00Z"),
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.plannerInfluence, false);
  assert.equal(result.databaseWrites, false);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.inheritedPolicyCount, 2);
  assert.deepEqual(result.inheritedShowIds, ["show-a", "show-b"]);
  assert.equal(result.podcast06.status, "READY_SHADOW");

  const showA = result.podcast06.shows.find((show) => show.spotifyShowId === "show-a");
  const showB = result.podcast06.shows.find((show) => show.spotifyShowId === "show-b");
  assert.equal(showA?.consumedCount, 1);
  assert.equal(showA?.limitReached, true);
  assert.deepEqual(showA?.projectedBlockedEpisodeIds, ["a-next"]);
  assert.equal(showB?.consumedCount, 0);
  assert.equal(showB?.limitReached, false);
  assert.deepEqual(showB?.projectedBlockedEpisodeIds, []);
  assert.deepEqual(result.projectedBlockedEpisodeIds, ["a-next"]);
  assert.deepEqual(result.podcast06.projectedPriorityOrderEpisodeIds, ["b-next"]);
});

test("Gate 4 preserves IN_PROGRESS continuation after inherited weekly budget is reached", () => {
  const policyResolution = resolution({
    episodes: [
      savedEpisode("a-continuation", "show-a"),
      savedEpisode("a-next", "show-a"),
    ],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [
      defaultCandidate("a-continuation", "show-a"),
      defaultCandidate("a-next", "show-a"),
    ],
    listeningStates: [
      {
        spotifyEpisodeId: "a-continuation",
        spotifyShowId: "show-a",
        status: "IN_PROGRESS",
        firstProgressObservedAt: new Date("2026-09-08T12:00:00Z"),
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.podcast06.status, "READY_SHADOW");
  assert.deepEqual(result.inProgressContinuationEpisodeIds, ["a-continuation"]);
  assert.deepEqual(result.projectedBlockedEpisodeIds, ["a-next"]);
  assert.deepEqual(result.podcast06.projectedPriorityOrderEpisodeIds, [
    "a-continuation",
  ]);
});

test("Gate 4 never applies the SAVED_EPISODES cadence to an explicit SHOW override", () => {
  const override = showOverride("show-a");
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a"), savedEpisode("b-next", "show-b")],
    overrides: [override],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [overrideCandidate("a-next", "show-a"), defaultCandidate("b-next", "show-b")],
    listeningStates: [
      {
        spotifyEpisodeId: "a-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-08T12:00:00Z"),
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.deepEqual(result.inheritedShowIds, ["show-b"]);
  assert.deepEqual(result.overrideExcludedShowIds, ["show-a"]);
  assert.equal(result.podcast06.shows.some((show) => show.spotifyShowId === "show-a"), false);
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
  assert.deepEqual(result.podcast06.projectedPriorityOrderEpisodeIds, [
    "a-next",
    "b-next",
  ]);
});

test("Gate 4 does not reinterpret GLOBAL_POOL as PER_SHOW", () => {
  const policy = savedPolicy({ frequencyScope: "GLOBAL_POOL" });
  const policyResolution = resolution({
    policy,
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.frequencyScope, "GLOBAL_POOL");
  assert.equal(result.inheritedPolicyCount, 0);
  assert.deepEqual(result.inheritedShowIds, []);
  assert.equal(result.podcast06.status, "NO_POLICY");
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
});

test("Gate 4 reuses PODCAST-06 timezone abstention instead of inventing a fallback window", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [],
    timeZone: null,
    asOf: AS_OF,
  });

  assert.equal(result.inheritedPolicyCount, 1);
  assert.equal(result.podcast06.status, "ABSTAIN_TIMEZONE_UNAVAILABLE");
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
});

test("Gate 4 reuses PODCAST-06 factual provenance abstention", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07InheritedPerShowCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [
      {
        spotifyEpisodeId: "historical-without-show",
        spotifyShowId: null,
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-08T12:00:00Z"),
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.podcast06.status, "ABSTAIN_INCOMPLETE_SHOW_PROVENANCE");
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
});
