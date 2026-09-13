import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner/types";

import {
  applyPodcast07PlannerRuntimeToCandidates,
  applyPodcast07SavedEpisodesCandidates,
  createPodcast07RuntimeState,
  resolvePodcast07Mode,
  runWithPodcast07RuntimeState,
  type Podcast07RuntimeState,
} from "./podcast-07-runtime";
import type { PodcastShowPolicyRuntimeSnapshot } from "./podcast-show-policy-history";

const TIME_ZONE = "America/Sao_Paulo";

function savedSource() {
  return {
    id: "saved-source",
    kind: "PODCAST",
    spotifyType: "SAVED_EPISODES",
    spotifyId: "saved-episodes",
    name: "Seus episódios",
    enabled: true,
    includePlayed: false,
  } as const;
}

function defaultPolicy(
  scope: "PER_SHOW" | "GLOBAL_POOL" = "PER_SHOW",
) {
  return {
    sourcePlaylistId: "saved-source",
    enabled: true,
    episodeOrder: "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    cadenceMaxEpisodes: 1,
    cadenceUnit: "WEEK",
    frequencyScope: scope,
  } as const;
}

function candidate(input: {
  id: string;
  showId?: string;
  sourcePlaylistId?: string;
  status?: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  releaseDate?: string;
}): Candidate {
  return {
    uri: `spotify:episode:${input.id}`,
    type: "PODCAST",
    title: input.id,
    programId: input.showId,
    durationMs: 30 * 60_000,
    originalDurationMs: 30 * 60_000,
    spotifyEpisodeId: input.id,
    podcastListeningStatus: input.status ?? "NOT_STARTED",
    sourcePlaylistId: input.sourcePlaylistId ?? "saved-source",
    sourceSpotifyType: "SAVED_EPISODES",
    sourceSpotifyId: "saved-episodes",
    releaseDate: input.releaseDate,
    releaseDatePrecision: input.releaseDate ? "day" : undefined,
  };
}

function state(input: {
  mode?: "OFF" | "SHADOW" | "ACTIVE";
  scope?: "PER_SHOW" | "GLOBAL_POOL";
  timeZone?: string | null;
  listeningStates?: Array<{
    spotifyEpisodeId: string;
    spotifyShowId: string | null;
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
    firstProgressObservedAt: Date | null;
  }>;
  specificCadence?: Map<
    string,
    {
      spotifyShowId: string;
      showName: string | null;
      cadenceMaxEpisodes: number | null;
      cadenceUnit: "DAY" | "WEEK" | "MONTH" | null;
      priority: "NORMAL" | "PRIORITY";
    }
  >;
} = {}): Podcast07RuntimeState {
  return createPodcast07RuntimeState({
    requestedMode: input.mode ?? "ACTIVE",
    userEmail: "pilot@example.com",
    activeEmailAllowlist: "pilot@example.com",
    timeZone: input.timeZone === undefined ? TIME_ZONE : input.timeZone,
    savedSource: savedSource(),
    defaultPolicy: defaultPolicy(input.scope),
    showOverrides: [],
    specificCadencePolicies: input.specificCadence ?? new Map(),
    listeningStates: input.listeningStates ?? [],
  });
}

function observedNow(
  id: string,
  showId: string | null,
  status: "IN_PROGRESS" | "COMPLETED" = "COMPLETED",
) {
  return {
    spotifyEpisodeId: id,
    spotifyShowId: showId,
    status,
    firstProgressObservedAt: new Date(Date.now() - 60_000),
  } as const;
}

test("ACTIVE requires an exact email allowlist match", () => {
  assert.deepEqual(
    resolvePodcast07Mode({
      requestedMode: "ACTIVE",
      userEmail: "pilot@example.com",
      activeEmailAllowlist: "other@example.com",
    }),
    {
      requestedMode: "ACTIVE",
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_EMAIL_NOT_ALLOWED",
    },
  );
});

test("PER_SHOW applies an independent inherited cadence budget", () => {
  const runtime = state({
    listeningStates: [observedNow("a-consumed", "show-a")],
  });
  const pool = [
    candidate({ id: "a-next", showId: "show-a" }),
    candidate({ id: "b-next", showId: "show-b" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output.map((entry) => entry.spotifyEpisodeId), ["b-next"]);
  assert.deepEqual(runtime.evidence.projectedBlockedEpisodeIds, ["a-next"]);
  assert.equal(runtime.evidence.plannerInfluence, true);
  assert.deepEqual(runtime.evidence.inheritedCadenceShowIds, ["show-a", "show-b"]);
});

test("IN_PROGRESS continues after the inherited weekly budget is reached", () => {
  const runtime = state({
    listeningStates: [observedNow("a-current", "show-a", "IN_PROGRESS")],
  });
  const pool = [
    candidate({ id: "a-current", showId: "show-a", status: "IN_PROGRESS" }),
    candidate({ id: "a-next", showId: "show-a" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output.map((entry) => entry.spotifyEpisodeId), ["a-current"]);
  assert.deepEqual(runtime.evidence.inProgressContinuationEpisodeIds, ["a-current"]);
});

test("GLOBAL_POOL shares one factual budget across default-governed shows", () => {
  const runtime = state({
    scope: "GLOBAL_POOL",
    listeningStates: [observedNow("a-consumed", "show-a")],
  });
  const pool = [
    candidate({ id: "a-next", showId: "show-a" }),
    candidate({ id: "b-next", showId: "show-b" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output, []);
  assert.equal(runtime.evidence.globalPoolConsumedCount, 1);
  assert.equal(runtime.evidence.globalPoolLimitReached, true);
  assert.deepEqual(runtime.evidence.projectedBlockedEpisodeIds, ["a-next", "b-next"]);
});

test("specific PODCAST-06 cadence remains authoritative over the default cadence", () => {
  const specific = new Map([
    [
      "show-b",
      {
        spotifyShowId: "show-b",
        showName: "B",
        cadenceMaxEpisodes: 2,
        cadenceUnit: "WEEK" as const,
        priority: "PRIORITY" as const,
      },
    ],
  ]);
  const runtime = state({
    scope: "GLOBAL_POOL",
    specificCadence: specific,
    listeningStates: [observedNow("a-consumed", "show-a")],
  });
  const pool = [
    candidate({ id: "a-next", showId: "show-a" }),
    candidate({ id: "b-next", showId: "show-b" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output.map((entry) => entry.spotifyEpisodeId), ["b-next"]);
  assert.ok(
    runtime.evidence.diagnosticCodes.includes(
      "PODCAST07_SPECIFIC_CADENCE_OVERRIDE_PRESERVED",
    ),
  );
});

test("SHADOW records the projection but returns the original pool", () => {
  const runtime = state({
    mode: "SHADOW",
    listeningStates: [observedNow("a-consumed", "show-a")],
  });
  const pool = [candidate({ id: "a-next", showId: "show-a" })];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output, pool);
  assert.deepEqual(runtime.evidence.projectedBlockedEpisodeIds, ["a-next"]);
  assert.equal(runtime.evidence.plannerInfluence, false);
});

test("missing civil timezone abstains and preserves the original pool", () => {
  const runtime = state({
    timeZone: null,
    listeningStates: [observedNow("a-consumed", "show-a")],
  });
  const pool = [candidate({ id: "a-next", showId: "show-a" })];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07PlannerRuntimeToCandidates(pool),
  );

  assert.deepEqual(output, pool);
  assert.equal(runtime.evidence.status, "ABSTAIN_TIMEZONE_UNAVAILABLE");
  assert.equal(runtime.evidence.plannerInfluence, false);
});

test("SAVED_ONLY uses the saved subset, ALL_EPISODES is suppressed, default order is per show", () => {
  const runtime = createPodcast07RuntimeState({
    requestedMode: "ACTIVE",
    userEmail: "pilot@example.com",
    activeEmailAllowlist: "pilot@example.com",
    timeZone: TIME_ZONE,
    savedSource: savedSource(),
    defaultPolicy: {
      ...defaultPolicy(),
      cadenceMaxEpisodes: null,
      cadenceUnit: null,
      episodeOrder: "OLDEST_FIRST",
    },
    showOverrides: [
      {
        sourcePlaylistId: "show-x-source",
        spotifyShowId: "show-x",
        showEpisodeScope: "SAVED_ONLY",
      },
      {
        sourcePlaylistId: "show-y-source",
        spotifyShowId: "show-y",
        showEpisodeScope: "ALL_EPISODES",
      },
    ],
    specificCadencePolicies: new Map(),
    listeningStates: [],
  });
  runtime.activeOverridesByShowId = new Map(runtime.overridesByShowId);

  const showPolicy: PodcastShowPolicyRuntimeSnapshot = {
    sourcePlaylistId: "show-x-source",
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
    publishedEpisodeIds: [],
  };

  const input = [
    candidate({ id: "a-new", showId: "show-a", releaseDate: "2026-09-10" }),
    candidate({ id: "x-saved", showId: "show-x", releaseDate: "2026-09-01" }),
    candidate({ id: "y-saved", showId: "show-y", releaseDate: "2026-09-01" }),
    candidate({ id: "a-old", showId: "show-a", releaseDate: "2026-08-01" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07SavedEpisodesCandidates({
      candidates: input,
      source: savedSource(),
      showPolicies: new Map([["show-x-source", showPolicy]]),
    }),
  );

  assert.deepEqual(output.map((entry) => entry.spotifyEpisodeId), [
    "a-old",
    "x-saved",
    "a-new",
  ]);
  const x = output.find((entry) => entry.spotifyEpisodeId === "x-saved")!;
  assert.equal(x.sourcePlaylistId, "show-x-source");
  assert.equal(x.sourceSpotifyType, "SHOW");
  assert.equal(x.sourceSpotifyId, "show-x");
  assert.ok(!output.some((entry) => entry.programId === "show-y"));
});

test("default RANDOM without replacement skips already published saved episodes", () => {
  const runtime = createPodcast07RuntimeState({
    requestedMode: "ACTIVE",
    userEmail: "pilot@example.com",
    activeEmailAllowlist: "pilot@example.com",
    timeZone: TIME_ZONE,
    savedSource: savedSource(),
    defaultPolicy: {
      ...defaultPolicy(),
      cadenceMaxEpisodes: null,
      cadenceUnit: null,
      episodeOrder: "RANDOM",
      randomPolicy: "WITHOUT_REPLACEMENT",
    },
    showOverrides: [],
    specificCadencePolicies: new Map(),
    listeningStates: [],
    defaultPublishedEpisodeIdsByShow: new Map([["show-a", ["a-1"]]]),
  });
  const input = [
    candidate({ id: "a-1", showId: "show-a" }),
    candidate({ id: "a-2", showId: "show-a" }),
    candidate({ id: "a-3", showId: "show-a" }),
  ];

  const output = runWithPodcast07RuntimeState(runtime, () =>
    applyPodcast07SavedEpisodesCandidates({
      candidates: input,
      source: savedSource(),
      showPolicies: new Map(),
    }),
  );

  assert.equal(output.length, 2);
  assert.ok(!output.some((entry) => entry.spotifyEpisodeId === "a-1"));
});
