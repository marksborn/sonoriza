import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithPlaybackReserveShadowRuntimeState,
  type PlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";
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
        { type: "PODCAST" as const, position: 0, uri: "spotify:episode:p0" },
        { type: "MUSIC" as const, position: 1, uri: "spotify:track:m1" },
        { type: "MUSIC" as const, position: 2, uri: "spotify:track:m2" },
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

function playbackReserveState(input: {
  primaryItemCount: number;
  selectedItems: Array<{
    uri: string;
    type: "MUSIC" | "PODCAST";
    position: number;
  }>;
}): PlaybackReserveShadowRuntimeState {
  return {
    gate: 8,
    configuredMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    simulate: false,
    plannerInfluence: true,
    spotifyWriteInfluence: true,
    additionalProviderReads: false,
    status: "READY_ACTIVE_REAL",
    targetPlaylistIds: [TARGET_ID],
    allowedTargetIds: new Set([TARGET_ID]),
    policies: new Map(),
    maintenanceMode: "KEEP_FILLED",
    rolePersistenceStatus: "PENDING",
    evidence: {
      gate: 8,
      mode: "ACTIVE",
      plannerInfluence: true,
      spotifyWriteInfluence: true,
      additionalProviderReads: false,
      status: "READY_ACTIVE",
      targetCount: 1,
      readyTargetCount: 1,
      shortfallTargetCount: 0,
      targets: [
        {
          targetPlaylistId: TARGET_ID,
          targetName: "Carro",
          status: "READY_SHADOW",
          plannerInfluence: false,
          spotifyWriteInfluence: false,
          additionalProviderReads: false,
          candidateCoverage: "PRIMARY_COLLECTION_ONLY",
          policy: null,
          primary: {
            itemCount: input.primaryItemCount,
            totalDurationMs: 1,
            compositionQualityPassed: true,
          },
          reserve: {
            startsAtPosition: input.primaryItemCount,
            itemCount: input.selectedItems.length,
            selectedItems: input.selectedItems,
          },
        },
      ],
    },
  } as unknown as PlaybackReserveShadowRuntimeState;
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

test("ACTIVE PLAYBACK-RESERVE excludes an exactly proven RESERVE suffix from legacy sequence validation", () => {
  const plan = [
    {
      targetPlaylistId: TARGET_ID,
      result: {
        items: [
          {
            type: "PODCAST" as const,
            position: 0,
            uri: "spotify:episode:primary",
          },
          {
            type: "PODCAST" as const,
            position: 1,
            uri: "spotify:episode:reserve",
          },
          {
            type: "MUSIC" as const,
            position: 2,
            uri: "spotify:track:reserve",
          },
        ],
      },
    },
  ];
  const runtime = playbackReserveState({
    primaryItemCount: 1,
    selectedItems: [
      {
        uri: "spotify:episode:reserve",
        type: "PODCAST",
        position: 1,
      },
      {
        uri: "spotify:track:reserve",
        type: "MUSIC",
        position: 2,
      },
    ],
  });

  const violations = runWithPlaybackReserveShadowRuntimeState(runtime, () =>
    sequencePrewriteViolations(plan, targetByPlanId),
  );

  assert.deepEqual(violations, []);
});

test("ACTIVE PLAYBACK-RESERVE never hides a sequence mismatch inside PRIMARY", () => {
  const plan = [
    {
      targetPlaylistId: TARGET_ID,
      result: {
        items: [
          {
            type: "MUSIC" as const,
            position: 0,
            uri: "spotify:track:invalid-primary",
          },
          {
            type: "PODCAST" as const,
            position: 1,
            uri: "spotify:episode:reserve",
          },
        ],
      },
    },
  ];
  const runtime = playbackReserveState({
    primaryItemCount: 1,
    selectedItems: [
      {
        uri: "spotify:episode:reserve",
        type: "PODCAST",
        position: 1,
      },
    ],
  });

  const violations = runWithPlaybackReserveShadowRuntimeState(runtime, () =>
    sequencePrewriteViolations(plan, targetByPlanId),
  );

  assert.deepEqual(violations, [
    {
      targetPlaylistId: TARGET_ID,
      targetName: "Carro",
      reason: "TYPE_MISMATCH",
      position: 0,
    },
  ]);
});

test("PLAYBACK-RESERVE evidence mismatch fails closed and keeps validating the full plan", () => {
  const plan = [
    {
      targetPlaylistId: TARGET_ID,
      result: {
        items: [
          {
            type: "PODCAST" as const,
            position: 0,
            uri: "spotify:episode:primary",
          },
          {
            type: "PODCAST" as const,
            position: 1,
            uri: "spotify:episode:physical-reserve",
          },
        ],
      },
    },
  ];
  const runtime = playbackReserveState({
    primaryItemCount: 1,
    selectedItems: [
      {
        uri: "spotify:episode:stale-evidence",
        type: "PODCAST",
        position: 1,
      },
    ],
  });

  const violations = runWithPlaybackReserveShadowRuntimeState(runtime, () =>
    sequencePrewriteViolations(plan, targetByPlanId),
  );

  assert.deepEqual(violations, [
    {
      targetPlaylistId: TARGET_ID,
      targetName: "Carro",
      reason: "TYPE_MISMATCH",
      position: 1,
    },
  ]);
});
