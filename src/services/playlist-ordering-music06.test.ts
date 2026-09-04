import assert from "node:assert/strict";
import test from "node:test";

import {
  createMusic06PlannerRuntimeState,
  resolveMusic06PlannerRuntimePolicy,
  runWithMusic06PlannerRuntimeState,
  type Music06PlannerRuntimePreparation,
} from "@/services/music-preference/lastfm-planner-runtime";
import type { Music06NegativeProjectionShadow } from "@/services/music-preference/lastfm-negative-projection-shadow";

import { applyMusicOrder, playlistOrderHash } from "./playlist-ordering";

const asOf = new Date("2026-09-04T15:00:00.000Z");

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
    tracks: [
      {
        trackKey: "artist\u0000b",
        identityMethod: "TRACK_ARTIST_NORMALIZED_EXACT",
        trackName: "B",
        artistName: "Artist",
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
      },
    ],
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

function music(uri: string, title: string, position: number, block?: number) {
  return {
    uri,
    type: "MUSIC" as const,
    position,
    title,
    subtitle: "Artist",
    spotifyTrackId: uri,
    primaryArtistId: "artist-1",
    primaryArtistName: "Artist",
    durationMs: 180_000,
    ...(block === undefined ? {} : { planningBlockIndex: block }),
  };
}

test("ORDER-01 STANDARD stays unchanged without a MUSIC-06 runtime context", () => {
  const input = [music("a", "A", 0), music("b", "B", 1), music("c", "C", 2), music("d", "D", 3)];
  const result = applyMusicOrder(input, "STANDARD", null);
  assert.deepEqual(result.items.map((row) => row.uri), ["a", "b", "c", "d"]);
  assert.equal(result.evidence.changed, false);
});

test("ORDER-01 STANDARD includes productive Gate 5B rerank in final hash", async () => {
  const state = createMusic06PlannerRuntimeState({ preparation: preparation() });
  const input = [music("a", "A", 0), music("b", "B", 1), music("c", "C", 2), music("d", "D", 3)];
  const result = await runWithMusic06PlannerRuntimeState(state, async () =>
    applyMusicOrder(input, "STANDARD", null),
  );
  assert.deepEqual(result.items.map((row) => row.uri), ["a", "c", "d", "b"]);
  assert.equal(result.evidence.changed, true);
  assert.equal(result.evidence.orderHash, playlistOrderHash(result.items));
  assert.equal(state.applied, true);
});

test("ORDER-01 + Gate 5B keep CALENDAR-02 identities inside their original blocks", async () => {
  const state = createMusic06PlannerRuntimeState({ preparation: preparation() });
  const input = [
    music("a", "A", 0, 0),
    music("b", "B", 1, 0),
    music("c", "C", 2, 0),
    music("x", "X", 3, 1),
    music("y", "Y", 4, 1),
  ];
  const result = await runWithMusic06PlannerRuntimeState(state, async () =>
    applyMusicOrder(input, "RANDOMIZED", "seed-gate5b"),
  );
  assert.deepEqual(result.items.slice(0, 3).map((row) => row.uri).sort(), ["a", "b", "c"]);
  assert.deepEqual(result.items.slice(3).map((row) => row.uri).sort(), ["x", "y"]);
  assert.deepEqual(result.items.map((row) => row.planningBlockIndex), [0, 0, 0, 1, 1]);
  assert.equal(result.evidence.orderHash, playlistOrderHash(result.items));
});
