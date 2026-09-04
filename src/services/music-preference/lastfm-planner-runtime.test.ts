import assert from "node:assert/strict";
import test from "node:test";

import { music06LastFmPlannerCapability } from "@/services/data-policy";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  applyMusic06PlannerInfluenceForCurrentRun,
  createMusic06PlannerRuntimeState,
  resolveMusic06PlannerRuntimePolicy,
  runWithMusic06PlannerRuntimeState,
  selectNonOverlappingMusic06SourceRuns,
  type Music06PlannerRuntimePreparation,
} from "./lastfm-planner-runtime";
import type {
  Music06NegativeProjectionShadow,
  Music06TrackNegativeProjection,
} from "./lastfm-negative-projection-shadow";

const asOf = new Date("2026-09-04T15:00:00.000Z");

function trackProjection(trackName = "B", artistName = "Artist"): Music06TrackNegativeProjection {
  return {
    trackKey: `${artistName.toLowerCase()}\u0000${trackName.toLowerCase()}`,
    identityMethod: "TRACK_ARTIST_NORMALIZED_EXACT",
    trackName,
    artistName,
    assessedOccurrenceCount: 4,
    inferredSkipCount: 3,
    negativeSignalCount: 3,
    skipRate: 0.75,
    recent30d: { assessedOccurrenceCount: 4, negativeOccurrenceCount: 3, skipRate: 0.75 },
    recent90d: { assessedOccurrenceCount: 4, negativeOccurrenceCount: 3, skipRate: 0.75 },
    recent30dSkipRate: 0.75,
    recent90dSkipRate: 0.75,
    lastNegativeAt: asOf,
    distinctNegativeDays: 2,
  };
}

function projection(): Music06NegativeProjectionShadow {
  return {
    mode: "SHADOW_READ_ONLY",
    asOf,
    sourceReportCount: 2,
    assessedOccurrenceCount: 4,
    negativeOccurrenceCount: 3,
    duplicateOccurrenceCount: 0,
    conflictingOccurrenceCount: 0,
    unprojectableOccurrenceCount: 0,
    tracks: [trackProjection()],
    artists: [],
  };
}

function preparation(): Music06PlannerRuntimePreparation {
  return {
    policyVersion: "music-06-gate5b-runtime-v1",
    status: "READY",
    policy: resolveMusic06PlannerRuntimePolicy({
      userEmail: "user@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }),
    asOf,
    projection: projection(),
    sourceRunIds: ["run-1", "run-2"],
    selectedTargetCount: 2,
    observation: null,
    failure: null,
  };
}

function item(
  uri: string,
  title: string,
  position: number,
  planningBlockIndex?: number,
) {
  return {
    uri,
    type: "MUSIC" as const,
    position,
    title,
    subtitle: "Artist",
    spotifyTrackId: uri,
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist",
    ...(planningBlockIndex === undefined ? {} : { planningBlockIndex }),
  };
}

function explicitNormal(): FirstPartyPlaybackPreference {
  return {
    id: "pref-b",
    userId: "user-1",
    subjectType: "TRACK",
    subjectKey: "spotify:track:b",
    policy: "NORMAL",
    source: "USER_EXPLICIT",
    createdAt: asOf,
    updatedAt: asOf,
  };
}

test("Gate 5B runtime requires feature flag and exact user allowlist", () => {
  assert.equal(
    resolveMusic06PlannerRuntimePolicy({
      userEmail: "user@example.com",
      masterEnabled: "false",
      allowlistedEmails: "user@example.com",
    }).reason,
    "MASTER_DISABLED",
  );
  assert.equal(
    resolveMusic06PlannerRuntimePolicy({
      userEmail: "user@example.com",
      masterEnabled: "true",
      allowlistedEmails: "other@example.com",
    }).reason,
    "USER_NOT_ALLOWLISTED",
  );
  assert.equal(
    resolveMusic06PlannerRuntimePolicy({
      userEmail: "USER@example.com",
      masterEnabled: "true",
      allowlistedEmails: "user@example.com",
    }).reason,
    "ENABLED",
  );
});

test("Gate 5B runtime remains off when scoped capability is blocked", () => {
  const capability = music06LastFmPlannerCapability();
  const blocked = { ...capability, boundedRerankDecision: "REVIEW_REQUIRED" as const, boundedRerankAllowed: false };
  const policy = resolveMusic06PlannerRuntimePolicy({
    userEmail: "user@example.com",
    masterEnabled: "true",
    allowlistedEmails: "user@example.com",
    capability: blocked,
  });
  assert.equal(policy.enabled, false);
  assert.equal(policy.reason, "CAPABILITY_BLOCKED");
});

test("Gate 5B source-run selection rejects overlapping evidence windows deterministically", () => {
  const lookbackFrom = new Date("2026-09-01T00:00:00.000Z");
  const rows = [
    { id: "new", startedAt: new Date("2026-09-04T12:00:00Z"), finishedAt: null, publishedAt: new Date("2026-09-04T12:00:00Z") },
    { id: "overlap", startedAt: new Date("2026-09-04T10:00:00Z"), finishedAt: null, publishedAt: new Date("2026-09-04T10:00:00Z") },
    { id: "old", startedAt: new Date("2026-09-04T05:00:00Z"), finishedAt: null, publishedAt: new Date("2026-09-04T05:00:00Z") },
  ];
  const selected = selectNonOverlappingMusic06SourceRuns({
    rows,
    asOf,
    lookbackFrom,
    windowHours: 6,
    maxSourceRuns: 10,
  });
  assert.deepEqual(selected.map((row) => row.id), ["new", "old"]);
});

test("Gate 5B runtime applies bounded rerank without moving podcast slots", async () => {
  const state = createMusic06PlannerRuntimeState({ preparation: preparation() });
  const input = [
    item("a", "A", 0),
    { uri: "pod", type: "PODCAST" as const, position: 1, title: "Podcast" },
    item("b", "B", 2),
    item("c", "C", 3),
    item("d", "D", 4),
  ];
  const output = await runWithMusic06PlannerRuntimeState(state, async () =>
    applyMusic06PlannerInfluenceForCurrentRun(input),
  );
  assert.deepEqual(output.map((row) => row.uri), ["a", "pod", "c", "d", "b"]);
  assert.equal(output[1]?.type, "PODCAST");
  assert.equal(state.applied, true);
  assert.equal(state.maxObservedMusicRankShift, 2);
});

test("Gate 5B runtime never moves identities across CALENDAR-02 blocks", async () => {
  const state = createMusic06PlannerRuntimeState({ preparation: preparation() });
  const input = [
    item("a", "A", 0, 0),
    item("b", "B", 1, 0),
    item("c", "C", 2, 0),
    item("x", "X", 3, 1),
    item("y", "Y", 4, 1),
  ];
  const output = await runWithMusic06PlannerRuntimeState(state, async () =>
    applyMusic06PlannerInfluenceForCurrentRun(input),
  );
  assert.deepEqual(output.slice(0, 3).map((row) => row.uri).sort(), ["a", "b", "c"]);
  assert.deepEqual(output.slice(3).map((row) => row.uri).sort(), ["x", "y"]);
  assert.deepEqual(output.map((row) => row.planningBlockIndex), [0, 0, 0, 1, 1]);
});

test("Gate 5B explicit first-party NORMAL suppresses inferred runtime demotion", async () => {
  const state = createMusic06PlannerRuntimeState({
    preparation: preparation(),
    firstPartyPreferences: [explicitNormal()],
  });
  const input = [item("a", "A", 0), item("b", "B", 1), item("c", "C", 2), item("d", "D", 3)];
  const output = await runWithMusic06PlannerRuntimeState(state, async () =>
    applyMusic06PlannerInfluenceForCurrentRun(input),
  );
  assert.deepEqual(output.map((row) => row.uri), ["a", "b", "c", "d"]);
  assert.equal(state.applied, false);
  assert.equal(state.explicitPreferenceSuppressedCount, 1);
});
