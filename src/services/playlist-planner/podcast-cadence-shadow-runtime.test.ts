import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "./types";
import { projectPodcast06PlannerShadow } from "./podcast-cadence-shadow-runtime";

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
        status: "IN_PROGRESS",
        firstProgressObservedAt: new Date("2026-09-07T08:20:02.363Z"),
      },
      {
        spotifyEpisodeId: next.spotifyEpisodeId!,
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
