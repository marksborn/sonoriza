import assert from "node:assert/strict";
import test from "node:test";

import {
  calendar03TargetOwnsComposition,
  createCalendar03PlannerRuntimeState,
  recordCalendar03RuntimeTargets,
} from "./calendar-event-composition-runtime";

const TARGET = "carro";
const EMAIL = "pilot@example.com";

function runtime(mode: "SHADOW" | "ACTIVE") {
  return createCalendar03PlannerRuntimeState({
    policies: new Map([
      [
        TARGET,
        {
          targetPlaylistId: TARGET,
          eventCompositionPolicy: "PODCAST_THEN_MUSIC" as const,
          maxPodcastsPerEvent: 1,
          podcastEventSafetyMarginSeconds: 120,
          podcastEventDistribution: "EVERY_N_EVENTS" as const,
          podcastEveryNEvents: 2,
          podcastEventOffset: 0,
        },
      ],
    ]),
    requestedMode: mode,
    userEmail: EMAIL,
    activeEmailAllowlist: EMAIL,
    activeTargetIds: TARGET,
  });
}

test("ownership requires ACTIVE + allowlisted exact target + READY_SHADOW + influence", () => {
  const state = runtime("ACTIVE");

  assert.equal(calendar03TargetOwnsComposition(state, TARGET), false);

  recordCalendar03RuntimeTargets(state, [
    {
      targetPlaylistId: TARGET,
      targetName: "Carro",
      policy: state.policies.get(TARGET)!,
      status: "READY_SHADOW",
      plannerInfluence: true,
      selectedPodcastUris: ["spotify:episode:p1"],
      blockDiagnostics: [],
    },
  ]);

  assert.equal(calendar03TargetOwnsComposition(state, TARGET), true);
  assert.equal(calendar03TargetOwnsComposition(state, "other"), false);
});

test("SHADOW never owns composition even with forged-looking target evidence", () => {
  const state = runtime("SHADOW");

  recordCalendar03RuntimeTargets(state, [
    {
      targetPlaylistId: TARGET,
      targetName: "Carro",
      policy: state.policies.get(TARGET)!,
      status: "READY_SHADOW",
      plannerInfluence: true,
      selectedPodcastUris: [],
      blockDiagnostics: [],
    },
  ]);

  assert.equal(calendar03TargetOwnsComposition(state, TARGET), false);
});
