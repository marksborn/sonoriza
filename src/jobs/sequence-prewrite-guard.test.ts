import assert from "node:assert/strict";
import test from "node:test";

import {
  createCalendar03PlannerRuntimeState,
  recordCalendar03RuntimeTargets,
  runWithCalendar03PlannerRuntimeState,
} from "@/services/playlist-planner/calendar-event-composition-runtime";

import { sequencePrewriteViolations } from "./sequence-prewrite-guard";

const TARGET_ID = "carro";
const EMAIL = "pilot@example.com";

const targetByPlanId = new Map([
  [
    TARGET_ID,
    {
      id: TARGET_ID,
      name: "Carro",
      compositionMode: "SEQUENCE",
      sequencePattern: ["PODCAST", "MUSIC"],
    },
  ],
]);

const divergentPlan = [
  {
    targetPlaylistId: TARGET_ID,
    result: {
      items: [
        { type: "PODCAST" as const, position: 0 },
        { type: "MUSIC" as const, position: 1 },
        { type: "MUSIC" as const, position: 2 },
      ],
    },
  },
];

function state(mode: "SHADOW" | "ACTIVE") {
  return createCalendar03PlannerRuntimeState({
    policies: new Map([
      [
        TARGET_ID,
        {
          targetPlaylistId: TARGET_ID,
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
    activeTargetIds: TARGET_ID,
  });
}

function record(
  runtime: ReturnType<typeof state>,
  input: {
    status: "READY_SHADOW" | "ABSTAIN_PRESERVED_ITEMS";
    plannerInfluence: boolean;
  },
) {
  recordCalendar03RuntimeTargets(runtime, [
    {
      targetPlaylistId: TARGET_ID,
      targetName: "Carro",
      policy: runtime.policies.get(TARGET_ID)!,
      status: input.status,
      plannerInfluence: input.plannerInfluence,
      selectedPodcastUris: [],
      blockDiagnostics: [],
    },
  ]);
}

test("legacy SEQUENCE divergence remains blocked without CALENDAR-03 runtime", () => {
  assert.deepEqual(
    sequencePrewriteViolations(divergentPlan, targetByPlanId),
    [
      {
        targetPlaylistId: TARGET_ID,
        targetName: "Carro",
        reason: "TYPE_MISMATCH",
        position: 2,
      },
    ],
  );
});

test("CALENDAR-03 SHADOW remains subject to the legacy sequence guard", () => {
  const runtime = state("SHADOW");
  record(runtime, { status: "READY_SHADOW", plannerInfluence: false });

  const violations = runWithCalendar03PlannerRuntimeState(runtime, () =>
    sequencePrewriteViolations(divergentPlan, targetByPlanId),
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.reason, "TYPE_MISMATCH");
});

test("ACTIVE without composition influence remains subject to the legacy guard", () => {
  const runtime = state("ACTIVE");
  record(runtime, {
    status: "ABSTAIN_PRESERVED_ITEMS",
    plannerInfluence: false,
  });

  const violations = runWithCalendar03PlannerRuntimeState(runtime, () =>
    sequencePrewriteViolations(divergentPlan, targetByPlanId),
  );

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.reason, "TYPE_MISMATCH");
});

test("ACTIVE READY_SHADOW with planner influence is owned by CALENDAR-03", () => {
  const runtime = state("ACTIVE");
  record(runtime, { status: "READY_SHADOW", plannerInfluence: true });

  const violations = runWithCalendar03PlannerRuntimeState(runtime, () =>
    sequencePrewriteViolations(divergentPlan, targetByPlanId),
  );

  assert.deepEqual(violations, []);
});
