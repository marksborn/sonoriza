import assert from "node:assert/strict";
import test from "node:test";

import { planRun } from "./plan-run";
import type { Candidate, PlaylistRules } from "./types";
import {
  applyPodcast06PlannerRuntimeToCandidates,
  createPodcast06PlannerShadowRuntimeState,
  podcast06PlannerShadowRuntimeSummary,
  projectPodcast06PlannerShadow,
  resolvePodcast06PlannerMode,
  runWithPodcast06PlannerShadowRuntimeState,
} from "./podcast-cadence-shadow-runtime";

const SCICAST = "0qfFcilKpNKkXy8TbZ4moP";

function podcast(input: {
  id: string;
  showId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  firstProgress?: Date | null;
}): Candidate {
  return {
    uri: `spotify:episode:${input.id}`,
    type: "PODCAST",
    title: input.id,
    programId: input.showId,
    spotifyEpisodeId: input.id,
    podcastListeningStatus: input.status,
    podcastFirstProgressObservedAt: input.firstProgress ?? null,
    durationMs: 60_000,
  };
}

function policy(input: {
  showId: string;
  name?: string;
  max?: number | null;
  unit?: "DAY" | "WEEK" | "MONTH" | null;
  priority?: "NORMAL" | "PRIORITY";
}) {
  return {
    spotifyShowId: input.showId,
    showName: input.name ?? input.showId,
    cadenceMaxEpisodes: input.max ?? null,
    cadenceUnit: input.unit ?? null,
    priority: input.priority ?? "NORMAL",
  } as const;
}

test("Scicast 1/WEEK projects limit reached but preserves IN_PROGRESS continuation", () => {
  const inProgress = podcast({
    id: "3oudiFs2CLZNfohYOuegV1",
    showId: SCICAST,
    status: "IN_PROGRESS",
    firstProgress: new Date("2026-09-07T08:20:02.363Z"),
  });
  const next = podcast({
    id: "next-scicast",
    showId: SCICAST,
    status: "NOT_STARTED",
  });

  const result = projectPodcast06PlannerShadow({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, name: "Scicast", max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: inProgress.spotifyEpisodeId!,
        spotifyShowId: null,
        status: "IN_PROGRESS",
        firstProgressObservedAt: new Date("2026-09-07T08:20:02.363Z"),
      },
      {
        spotifyEpisodeId: next.spotifyEpisodeId!,
        spotifyShowId: null,
        status: "NOT_STARTED",
        firstProgressObservedAt: null,
      },
    ],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-07T22:21:07.670Z"),
    candidates: [inProgress, next],
    plannedItems: [inProgress],
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.plannerInfluence, false);
  assert.equal(result.unresolvedFactualCount, 0);
  assert.equal(result.shows.length, 1);
  assert.deepEqual(result.shows[0], {
    spotifyShowId: SCICAST,
    showName: "Scicast",
    cadenceMaxEpisodes: 1,
    cadenceUnit: "WEEK",
    priority: "NORMAL",
    candidateCount: 2,
    consumedCount: 1,
    limitReached: true,
    newEpisodeAllowedByCadence: false,
    inProgressContinuationEpisodeIds: ["3oudiFs2CLZNfohYOuegV1"],
    projectedBlockedEpisodeIds: ["next-scicast"],
    diagnosticCodes: [
      "SHOW_CADENCE_LIMIT_REACHED",
      "SHOW_CADENCE_IN_PROGRESS_CONTINUATION",
    ],
  });
  assert.deepEqual(result.plannedPodcastEpisodeIds, ["3oudiFs2CLZNfohYOuegV1"]);
});

test("canonical show provenance resolves factual consumption outside the current pool", () => {
  const next = podcast({
    id: "next-scicast",
    showId: SCICAST,
    status: "NOT_STARTED",
  });
  const result = projectPodcast06PlannerShadow({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: "historical-not-in-pool",
        spotifyShowId: SCICAST,
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-07T12:00:00Z"),
      },
    ],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-07T22:00:00Z"),
    candidates: [next],
  });

  assert.equal(result.status, "READY_SHADOW");
  assert.equal(result.unresolvedFactualCount, 0);
  assert.equal(result.shows[0]?.consumedCount, 1);
  assert.equal(result.shows[0]?.limitReached, true);
  assert.equal(result.shows[0]?.newEpisodeAllowedByCadence, false);
  assert.deepEqual(result.shows[0]?.projectedBlockedEpisodeIds, ["next-scicast"]);
});

test("unresolved factual consumption fails closed instead of undercounting cadence", () => {
  const candidate = podcast({
    id: "current",
    showId: SCICAST,
    status: "NOT_STARTED",
  });
  const result = projectPodcast06PlannerShadow({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: "historical-not-in-pool",
        spotifyShowId: null,
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-07T12:00:00Z"),
      },
    ],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-07T22:00:00Z"),
    candidates: [candidate],
  });

  assert.equal(result.status, "ABSTAIN_INCOMPLETE_SHOW_PROVENANCE");
  assert.equal(result.unresolvedFactualCount, 1);
  assert.equal(result.shows[0]?.limitReached, null);
  assert.deepEqual(result.shows[0]?.projectedBlockedEpisodeIds, []);
});

test("configured policy without timezone abstains", () => {
  const candidate = podcast({ id: "episode", showId: SCICAST, status: "NOT_STARTED" });
  const result = projectPodcast06PlannerShadow({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [],
    timeZone: null,
    asOf: new Date("2026-09-07T22:00:00Z"),
    candidates: [candidate],
  });

  assert.equal(result.status, "ABSTAIN_TIMEZONE_UNAVAILABLE");
  assert.equal(result.shows[0]?.consumedCount, null);
});

test("priority projection is stable and diagnostic only", () => {
  const normal = podcast({ id: "normal", showId: "normal-show", status: "NOT_STARTED" });
  const priorityA = podcast({ id: "priority-a", showId: "priority-show", status: "NOT_STARTED" });
  const priorityB = podcast({ id: "priority-b", showId: "priority-show", status: "NOT_STARTED" });

  const result = projectPodcast06PlannerShadow({
    policies: new Map([
      ["priority-show", policy({ showId: "priority-show", priority: "PRIORITY" })],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-07T22:00:00Z"),
    candidates: [normal, priorityA, priorityB],
    plannedItems: [normal],
  });

  assert.deepEqual(result.actualPoolOrderEpisodeIds, ["normal", "priority-a", "priority-b"]);
  assert.deepEqual(result.projectedPriorityOrderEpisodeIds, ["priority-a", "priority-b", "normal"]);
  assert.equal(result.projectedPriorityMovedCount, 3);
  assert.deepEqual(result.plannedPodcastEpisodeIds, ["normal"]);
  assert.equal(result.plannerInfluence, false);
  assert.deepEqual(result.shows[0]?.diagnosticCodes, ["SHOW_PRIORITY_APPLIED"]);
});

test("pre-plan summary is NOT_OBSERVED and only factual rows count as unresolved factual", () => {
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: "factual",
        spotifyShowId: null,
        status: "IN_PROGRESS",
        firstProgressObservedAt: new Date("2026-09-07T08:20:02.363Z"),
      },
      {
        spotifyEpisodeId: "not-started",
        spotifyShowId: null,
        status: "NOT_STARTED",
        firstProgressObservedAt: null,
      },
    ],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-07T22:00:00Z"),
  });

  const summary = podcast06PlannerShadowRuntimeSummary(state);
  assert.equal(summary.status, "NOT_OBSERVED");
  assert.equal(summary.listeningStateCount, 2);
  assert.equal(summary.unresolvedStateCount, 2);
  assert.equal(summary.unresolvedFactualCount, 1);
  assert.equal(summary.plannerInfluence, false);
  assert.equal(summary.effectiveMode, "SHADOW");
});

test("no policies is a no-op shadow state", () => {
  const result = projectPodcast06PlannerShadow({
    policies: new Map(),
    listeningStates: [],
    timeZone: null,
    asOf: new Date("2026-09-07T22:00:00Z"),
    candidates: [],
  });
  assert.equal(result.status, "NO_POLICY");
  assert.equal(result.configuredPolicyCount, 0);
  assert.equal(result.plannerInfluence, false);
});

test("Gate 5A ACTIVE requires an exact case-insensitive email allowlist match", () => {
  assert.deepEqual(
    resolvePodcast06PlannerMode({
      requestedMode: "ACTIVE",
      userEmail: "User@Example.com",
      activeEmailAllowlist: "other@example.com,user@example.com",
    }),
    {
      requestedMode: "ACTIVE",
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
    },
  );
  assert.deepEqual(
    resolvePodcast06PlannerMode({
      requestedMode: "ACTIVE",
      userEmail: "user@example.com",
      activeEmailAllowlist: "other@example.com",
    }),
    {
      requestedMode: "ACTIVE",
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_EMAIL_NOT_ALLOWED",
    },
  );
  assert.equal(
    resolvePodcast06PlannerMode({ requestedMode: "typo" }).effectiveMode,
    "OFF",
  );
});

test("Gate 5A ACTIVE blocks a new episode at cadence limit but keeps IN_PROGRESS", () => {
  const continuation = podcast({
    id: "continuation",
    showId: SCICAST,
    status: "IN_PROGRESS",
  });
  const next = podcast({ id: "next", showId: SCICAST, status: "NOT_STARTED" });
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [
      {
        spotifyEpisodeId: "already-consumed",
        spotifyShowId: SCICAST,
        status: "COMPLETED",
        firstProgressObservedAt: new Date("2026-09-07T12:00:00Z"),
      },
    ],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-08T12:00:00Z"),
    requestedMode: "ACTIVE",
    userEmail: "user@example.com",
    activeEmailAllowlist: "user@example.com",
  });

  const output = runWithPodcast06PlannerShadowRuntimeState(state, () =>
    applyPodcast06PlannerRuntimeToCandidates([next, continuation]),
  );
  const summary = podcast06PlannerShadowRuntimeSummary(state);

  assert.deepEqual(output.map((candidate) => candidate.spotifyEpisodeId), [
    "continuation",
  ]);
  assert.equal(summary.status, "READY_SHADOW");
  assert.equal(summary.plannerInfluence, true);
  assert.equal(summary.effectiveMode, "ACTIVE");
  assert.deepEqual(summary.shows[0]?.diagnosticCodes, [
    "SHOW_CADENCE_LIMIT_REACHED",
    "SHOW_CADENCE_IN_PROGRESS_CONTINUATION",
  ]);
});

test("Gate 5A priority is stable after cadence eligibility", () => {
  const normal = podcast({ id: "normal", showId: "normal-show", status: "NOT_STARTED" });
  const priorityA = podcast({ id: "priority-a", showId: "priority-show", status: "NOT_STARTED" });
  const priorityB = podcast({ id: "priority-b", showId: "priority-show", status: "NOT_STARTED" });
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      ["priority-show", policy({ showId: "priority-show", priority: "PRIORITY" })],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-08T12:00:00Z"),
    requestedMode: "ACTIVE",
    userEmail: "user@example.com",
    activeEmailAllowlist: "user@example.com",
  });

  const output = runWithPodcast06PlannerShadowRuntimeState(state, () =>
    applyPodcast06PlannerRuntimeToCandidates([normal, priorityA, priorityB]),
  );

  assert.deepEqual(output.map((candidate) => candidate.spotifyEpisodeId), [
    "priority-a",
    "priority-b",
    "normal",
  ]);
  assert.equal(podcast06PlannerShadowRuntimeSummary(state).plannerInfluence, true);
});

test("Gate 5A requested ACTIVE without allowlist stays SHADOW and returns original pool", () => {
  const normal = podcast({ id: "normal", showId: "normal-show", status: "NOT_STARTED" });
  const priority = podcast({ id: "priority", showId: "priority-show", status: "NOT_STARTED" });
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      ["priority-show", policy({ showId: "priority-show", priority: "PRIORITY" })],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-08T12:00:00Z"),
    requestedMode: "ACTIVE",
    userEmail: "user@example.com",
    activeEmailAllowlist: "other@example.com",
  });

  const output = runWithPodcast06PlannerShadowRuntimeState(state, () =>
    applyPodcast06PlannerRuntimeToCandidates([normal, priority]),
  );
  const summary = podcast06PlannerShadowRuntimeSummary(state);

  assert.deepEqual(output.map((candidate) => candidate.spotifyEpisodeId), [
    "normal",
    "priority",
  ]);
  assert.equal(summary.effectiveMode, "SHADOW");
  assert.equal(summary.activationReason, "ACTIVE_EMAIL_NOT_ALLOWED");
  assert.equal(summary.plannerInfluence, false);
  assert.equal(summary.projectedPriorityMovedCount, 2);
});

test("Gate 5A ACTIVE abstains when any podcast candidate lacks show provenance", () => {
  const missingShow: Candidate = {
    ...podcast({ id: "missing-show", showId: SCICAST, status: "NOT_STARTED" }),
    programId: undefined,
  };
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      [SCICAST, policy({ showId: SCICAST, max: 1, unit: "WEEK" })],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-08T12:00:00Z"),
    requestedMode: "ACTIVE",
    userEmail: "user@example.com",
    activeEmailAllowlist: "user@example.com",
  });

  const output = runWithPodcast06PlannerShadowRuntimeState(state, () =>
    applyPodcast06PlannerRuntimeToCandidates([missingShow]),
  );
  const summary = podcast06PlannerShadowRuntimeSummary(state);

  assert.equal(output.length, 1);
  assert.equal(summary.status, "ABSTAIN_INCOMPLETE_CANDIDATE_SHOW_PROVENANCE");
  assert.equal(summary.plannerInfluence, false);
});

test("Gate 5A planRun uses the ACTIVE priority projection before existing planner rules", () => {
  const normal = podcast({ id: "normal", showId: "normal-show", status: "NOT_STARTED" });
  const priority = podcast({ id: "priority", showId: "priority-show", status: "NOT_STARTED" });
  const state = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      ["priority-show", policy({ showId: "priority-show", priority: "PRIORITY" })],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-08T12:00:00Z"),
    requestedMode: "ACTIVE",
    userEmail: "user@example.com",
    activeEmailAllowlist: "user@example.com",
  });
  const rules: PlaylistRules = {
    targetDurationMs: 60_000,
    compositionMode: "PROPORTION",
    podcastPercent: 100,
    sequencePattern: ["PODCAST"],
    maxEpisodesPerProgram: 10,
  };

  const result = runWithPodcast06PlannerShadowRuntimeState(state, () =>
    planRun({
      pools: { music: [], podcasts: [normal, priority] },
      targets: [
        {
          targetPlaylistId: "target",
          name: "Target",
          priority: 0,
          rules,
        },
      ],
    }),
  );
  const summary = podcast06PlannerShadowRuntimeSummary(state);

  assert.deepEqual(
    result.targets[0]?.result.items.map((candidate) => candidate.spotifyEpisodeId),
    ["priority"],
  );
  assert.equal(summary.plannerInfluence, true);
  assert.deepEqual(summary.plannedPodcastEpisodeIds, ["priority"]);
});
