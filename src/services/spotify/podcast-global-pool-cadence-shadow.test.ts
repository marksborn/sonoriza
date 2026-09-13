import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePodcastEffectivePolicyShadow,
  type PodcastShowOverrideShadow,
} from "./podcast-effective-policy-shadow";
import type { Podcast07PoolShadowCandidate } from "./podcast-efficient-pool-shadow";
import { projectPodcast07GlobalPoolCadenceShadow } from "./podcast-global-pool-cadence-shadow";
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
    frequencyScope: "GLOBAL_POOL",
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

function showPolicy(sourcePlaylistId: string): PodcastShowPolicyStoredSnapshot {
  return {
    sourcePlaylistId,
    episodeEligibility: "UNPLAYED_ONLY",
    episodeOrder: "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    showEpisodeScope: "SAVED_ONLY",
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
const THIS_WEEK = new Date("2026-09-08T12:00:00Z");

test("Gate 5 shares one 1/WEEK budget across all default-governed shows", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a"), savedEpisode("b-next", "show-b")],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a"), defaultCandidate("b-next", "show-b")],
    listeningStates: [
      {
        spotifyEpisodeId: "a-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.plannerInfluence, false);
  assert.equal(result.databaseWrites, false);
  assert.equal(result.spotifyWrites, false);
  assert.deepEqual(result.governedShowIds, ["show-a", "show-b"]);
  assert.equal(result.consumedCount, 1);
  assert.deepEqual(result.consumedEpisodeIds, ["a-consumed"]);
  assert.equal(result.limitReached, true);
  assert.equal(result.newEpisodeAllowedByCadence, false);
  assert.deepEqual(result.projectedBlockedEpisodeIds, ["a-next", "b-next"]);
  assert.ok(result.diagnosticCodes.includes("GLOBAL_POOL_CADENCE_LIMIT_REACHED"));
});

test("Gate 5 preserves IN_PROGRESS continuation while the shared budget is exhausted", () => {
  const policyResolution = resolution({
    episodes: [
      savedEpisode("a-next", "show-a"),
      savedEpisode("b-continuation", "show-b"),
      savedEpisode("b-next", "show-b"),
    ],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [
      defaultCandidate("a-next", "show-a"),
      defaultCandidate("b-continuation", "show-b"),
      defaultCandidate("b-next", "show-b"),
    ],
    listeningStates: [
      {
        spotifyEpisodeId: "a-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
      {
        spotifyEpisodeId: "b-continuation",
        spotifyShowId: "show-b",
        status: "IN_PROGRESS",
        firstProgressObservedAt: new Date("2026-09-05T12:00:00Z"),
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.limitReached, true);
  assert.deepEqual(result.inProgressContinuationEpisodeIds, ["b-continuation"]);
  assert.deepEqual(result.projectedBlockedEpisodeIds, ["a-next", "b-next"]);
  assert.ok(result.diagnosticCodes.includes("GLOBAL_POOL_IN_PROGRESS_CONTINUATION"));
});

test("Gate 5 never blocks an explicit SHOW override with the default shared budget", () => {
  const override = showOverride("show-x");
  const policyResolution = resolution({
    episodes: [
      savedEpisode("a-next", "show-a"),
      savedEpisode("b-next", "show-b"),
      savedEpisode("x-next", "show-x"),
    ],
    overrides: [override],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [
      defaultCandidate("a-next", "show-a"),
      defaultCandidate("b-next", "show-b"),
      overrideCandidate("x-next", "show-x"),
    ],
    listeningStates: [
      {
        spotifyEpisodeId: "a-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.deepEqual(result.overrideExcludedShowIds, ["show-x"]);
  assert.equal(result.governedCandidateCount, 2);
  assert.deepEqual(result.projectedBlockedEpisodeIds, ["a-next", "b-next"]);
  assert.equal(result.projectedBlockedEpisodeIds.includes("x-next"), false);
});

test("Gate 5 governance changes inside the week use current authority deterministically", () => {
  const episodes = [
    savedEpisode("a-saved", "show-a"),
    savedEpisode("b-next", "show-b"),
  ];
  const listeningStates = [
    {
      spotifyEpisodeId: "a-consumed",
      spotifyShowId: "show-a",
      status: "COMPLETED" as const,
      firstProgressObservedAt: THIS_WEEK,
    },
  ];

  const beforeOverride = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution: resolution({ episodes }),
    candidates: [defaultCandidate("a-saved", "show-a"), defaultCandidate("b-next", "show-b")],
    listeningStates,
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });
  assert.equal(beforeOverride.consumedCount, 1);
  assert.deepEqual(beforeOverride.projectedBlockedEpisodeIds, ["a-saved", "b-next"]);

  const afterOverride = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution: resolution({ episodes, overrides: [showOverride("show-a")] }),
    candidates: [overrideCandidate("a-saved", "show-a"), defaultCandidate("b-next", "show-b")],
    listeningStates,
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(
    afterOverride.governanceSemantics,
    "CURRENT_EFFECTIVE_AUTHORITY_AT_EVALUATION",
  );
  assert.deepEqual(afterOverride.governedShowIds, ["show-b"]);
  assert.deepEqual(afterOverride.overrideExcludedShowIds, ["show-a"]);
  assert.equal(afterOverride.consumedCount, 0);
  assert.equal(afterOverride.limitReached, false);
  assert.deepEqual(afterOverride.projectedBlockedEpisodeIds, []);
  assert.deepEqual(afterOverride.excludedFactualConsumption, [
    {
      spotifyEpisodeId: "a-consumed",
      spotifyShowId: "show-a",
      firstProgressObservedAt: THIS_WEEK.toISOString(),
      reason: "SHOW_OVERRIDE",
    },
  ]);
  assert.ok(
    afterOverride.diagnosticCodes.includes(
      "GLOBAL_POOL_OVERRIDE_FACTUAL_CONSUMPTION_EXCLUDED",
    ),
  );
});

test("Gate 5 excludes factual consumption from a show no longer in the current saved pool", () => {
  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution: resolution({
      episodes: [savedEpisode("b-next", "show-b")],
    }),
    candidates: [defaultCandidate("b-next", "show-b")],
    listeningStates: [
      {
        spotifyEpisodeId: "old-consumed",
        spotifyShowId: "old-show",
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.consumedCount, 0);
  assert.equal(result.excludedFactualListeningStateCount, 1);
  assert.deepEqual(result.excludedFactualConsumption, [
    {
      spotifyEpisodeId: "old-consumed",
      spotifyShowId: "old-show",
      firstProgressObservedAt: THIS_WEEK.toISOString(),
      reason: "NOT_IN_CURRENT_SAVED_POOL",
    },
  ]);
});

test("Gate 5 dedupes repeated factual observations through the PODCAST-06 cadence engine", () => {
  const policyResolution = resolution({
    policy: savedPolicy({ cadenceMaxEpisodes: 2 }),
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [
      {
        spotifyEpisodeId: "same-consumed",
        spotifyShowId: "show-a",
        status: "IN_PROGRESS",
        firstProgressObservedAt: THIS_WEEK,
      },
      {
        spotifyEpisodeId: "same-consumed",
        spotifyShowId: "show-a",
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.consumedCount, 1);
  assert.deepEqual(result.consumedEpisodeIds, ["same-consumed"]);
  assert.equal(result.limitReached, false);
});

test("Gate 5 abstains on unresolved factual show provenance instead of undercounting", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [
      {
        spotifyEpisodeId: "historical-unknown-show",
        spotifyShowId: null,
        status: "COMPLETED",
        firstProgressObservedAt: THIS_WEEK,
      },
    ],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.status, "ABSTAIN_INCOMPLETE_FACTUAL_PROVENANCE");
  assert.equal(result.unresolvedFactualListeningStateCount, 1);
  assert.equal(result.consumedCount, null);
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
});

test("Gate 5 abstains without user timezone and does not invent a weekly window", () => {
  const policyResolution = resolution({
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [],
    timeZone: null,
    asOf: AS_OF,
  });

  assert.equal(result.status, "ABSTAIN_TIMEZONE_UNAVAILABLE");
  assert.equal(result.window, null);
  assert.equal(result.consumedCount, null);
});

test("Gate 5 does not reinterpret PER_SHOW as a global budget", () => {
  const policyResolution = resolution({
    policy: savedPolicy({ frequencyScope: "PER_SHOW" }),
    episodes: [savedEpisode("a-next", "show-a")],
  });

  const result = projectPodcast07GlobalPoolCadenceShadow({
    policyResolution,
    candidates: [defaultCandidate("a-next", "show-a")],
    listeningStates: [],
    timeZone: TIME_ZONE,
    asOf: AS_OF,
  });

  assert.equal(result.status, "NOT_GLOBAL_POOL");
  assert.equal(result.consumedCount, null);
  assert.deepEqual(result.projectedBlockedEpisodeIds, []);
});
