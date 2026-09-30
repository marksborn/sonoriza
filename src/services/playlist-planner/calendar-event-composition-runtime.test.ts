import assert from "node:assert/strict";
import test from "node:test";

import {
  createCalendar03PlannerRuntimeState,
  resolveCalendar03PlannerMode,
  runWithCalendar03PlannerRuntimeState,
} from "./calendar-event-composition-runtime";
import { planRun } from "./plan-run-calendar03";
import type { Candidate, RunTarget } from "./index";
import {
  createPodcast06PlannerShadowRuntimeState,
  runWithPodcast06PlannerShadowRuntimeState,
} from "./podcast-cadence-shadow-runtime";

const MINUTE = 60_000;
const EMAIL = "pilot@example.com";
const TARGET = "carro";

function music(id: string, minutes: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    primaryArtistId: `artist:${id}`,
    albumId: `album:${id}`,
    durationMs: minutes * MINUTE,
  };
}

function podcast(
  id: string,
  show: string,
  minutes: number,
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: show,
    durationMs: minutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
  };
}

function target(id = TARGET): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 0,
    durationBlocks: [
      { key: "E1", targetDurationMs: 30 * MINUTE },
    ],
    rules: {
      targetDurationMs: 30 * MINUTE,
      compositionMode: "SEQUENCE",
      podcastPercent: 50,
      sequencePattern: ["PODCAST", "MUSIC"],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function carTarget(): RunTarget {
  return {
    ...target(),
    durationBlocks: [
      { key: "IDA", targetDurationMs: 30 * MINUTE },
      { key: "VOLTA", targetDurationMs: 30 * MINUTE },
    ],
    rules: {
      ...target().rules,
      targetDurationMs: 60 * MINUTE,
      sequencePattern: [
        "PODCAST",
        "MUSIC",
        "MUSIC",
        "MUSIC",
        "MUSIC",
        "MUSIC",
      ],
    },
  };
}

function calendar03State(options: {
  mode?: string;
  targets?: string;
} = {}) {
  return createCalendar03PlannerRuntimeState({
    policies: new Map([
      [
        TARGET,
        {
          targetPlaylistId: TARGET,
          eventCompositionPolicy: "PODCAST_THEN_MUSIC" as const,
          maxPodcastsPerEvent: 1,
          podcastEventSafetyMarginSeconds: 0,
          podcastEventDistribution: "EVERY_EVENT" as const,
          podcastEveryNEvents: 1,
          podcastEventOffset: 0,
        },
      ],
    ]),
    requestedMode: options.mode ?? "ACTIVE",
    userEmail: EMAIL,
    activeEmailAllowlist: EMAIL,
    activeTargetIds: options.targets ?? TARGET,
  });
}

function carCalendar03State() {
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
    requestedMode: "ACTIVE",
    userEmail: EMAIL,
    activeEmailAllowlist: EMAIL,
    activeTargetIds: TARGET,
  });
}

test("ACTIVE requires both email and target allowlists", () => {
  assert.deepEqual(
    resolveCalendar03PlannerMode({
      requestedMode: "ACTIVE",
      userEmail: EMAIL,
      activeEmailAllowlist: EMAIL,
      activeTargetIds: TARGET,
    }).activationReason,
    "ACTIVE_ALLOWED",
  );
  assert.equal(
    resolveCalendar03PlannerMode({
      requestedMode: "ACTIVE",
      userEmail: EMAIL,
      activeEmailAllowlist: "other@example.com",
      activeTargetIds: TARGET,
    }).effectiveMode,
    "SHADOW",
  );
  assert.equal(
    resolveCalendar03PlannerMode({
      requestedMode: "ACTIVE",
      userEmail: EMAIL,
      activeEmailAllowlist: EMAIL,
      activeTargetIds: "",
    }).activationReason,
    "ACTIVE_TARGET_NOT_ALLOWED",
  );
});

test("SHADOW returns the exact legacy plan and records no planner influence", () => {
  const state = calendar03State({ mode: "SHADOW" });
  const input = {
    pools: {
      podcasts: [podcast("p20", "show-a", 20)],
      music: [music("m10", 10)],
    },
    targets: [target()],
  };

  const result = runWithCalendar03PlannerRuntimeState(state, () => planRun(input));

  assert.equal(state.evidence.plannerInfluence, false);
  assert.equal(state.evidence.targets[0]?.status, "READY_SHADOW");
  assert.equal(result.targets.length, 1);
});

test("ACTIVE single-target applies PODCAST_THEN_MUSIC and never crosses the block", () => {
  const state = calendar03State();
  const result = runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("p20", "show-a", 20)],
        music: [music("m10", 10), music("m5", 5)],
      },
      targets: [target()],
    }),
  );

  const planned = result.targets[0]!.result;
  assert.equal(state.evidence.plannerInfluence, true);
  assert.equal(state.evidence.targets[0]?.status, "READY_SHADOW");
  assert.deepEqual(
    planned.items.map((item) => item.uri),
    ["spotify:episode:p20", "spotify:track:m10"],
  );
  assert.equal(planned.stats.segmentation?.blocks[0]?.filledDurationMs, 30 * MINUTE);
  assert.equal(planned.stats.compositionQualityPassed, true);
});

test("ACTIVE single-target honors external EXCLUSIVE reservations and preserves sharing evidence", () => {
  const state = calendar03State();
  const shared = music("shared", 10);
  const fresh = music("fresh", 10);

  const result = runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("p20", "show-a", 20)],
        music: [shared, fresh],
      },
      targets: [target()],
      sharingPolicyByTargetId: new Map([[TARGET, "EXCLUSIVE" as const]]),
      externalReservationsByUri: new Map([
        [
          shared.uri,
          [
            {
              targetPlaylistId: "trabalho",
              sharingPolicy: "EXCLUSIVE" as const,
            },
          ],
        ],
      ]),
    }),
  );

  assert.equal(state.evidence.plannerInfluence, true);
  assert.deepEqual(
    result.targets[0]!.result.items.map((item) => item.uri),
    ["spotify:episode:p20", fresh.uri],
  );
  assert.equal(result.targets[0]!.result.items.some((item) => item.uri === shared.uri), false);
  assert.equal(result.targetSharingRuntime?.plannerInfluence, true);
  assert.equal(result.targetSharingRuntime?.targets[0]?.blockedByPolicyCount, 1);
  assert.deepEqual(
    result.targetSharingRuntime?.targets[0]?.conflictingTargetIds,
    ["trabalho"],
  );
});

test("ACTIVE multi-target fails closed to the legacy planner", () => {
  const state = calendar03State({ targets: `${TARGET},other` });
  const result = runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("p20", "show-a", 20)],
        music: [music("m10", 10), music("m5", 5)],
      },
      targets: [target(), { ...target("other"), priority: 1 }],
    }),
  );

  assert.equal(state.evidence.plannerInfluence, false);
  assert.equal(
    state.evidence.targets.find((entry) => entry.targetPlaylistId === TARGET)?.status,
    "ABSTAIN_MULTI_TARGET_ACTIVE_SCOPE",
  );
  assert.equal(result.targets.length, 2);
});

test("ACTIVE KEEP_FILLED preserves E1 podcast and keeps the return block music-only", () => {
  const state = carCalendar03State();
  const preservedNews = podcast("preserved-news", "show-news", 10);
  const result = runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("fresh-news", "show-fresh", 10)],
        music: [
          music("m1", 10),
          music("m2", 10),
          music("m3", 10),
          music("m4", 10),
          music("m5", 10),
        ],
      },
      targets: [carTarget()],
      preservedByTargetId: new Map([[TARGET, [preservedNews]]]),
    }),
  );

  const planned = result.targets[0]!.result;
  const blocks = planned.stats.segmentation?.blocks ?? [];

  assert.equal(state.evidence.plannerInfluence, true);
  assert.equal(state.evidence.targets[0]?.status, "READY_SHADOW");
  assert.equal(planned.items[0]?.uri, preservedNews.uri);
  assert.deepEqual(
    blocks.map((block) => block.podcastDurationMs),
    [10 * MINUTE, 0],
  );
  assert.equal(
    planned.items.some(
      (item) => item.planningBlockIndex === 1 && item.type === "PODCAST",
    ),
    false,
  );
  assert.equal(planned.stats.compositionQualityPassed, true);
  assert.ok(
    blocks.every((block) => block.filledDurationMs <= block.targetDurationMs),
  );
});

test("ACTIVE KEEP_FILLED never inserts a fresh podcast before preserved music", () => {
  const state = calendar03State();
  const preservedMusic = music("preserved", 5);
  const result = runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("p20", "show-a", 20)],
        music: [music("m10", 10), music("m15", 15)],
      },
      targets: [target()],
      preservedByTargetId: new Map([[TARGET, [preservedMusic]]]),
    }),
  );

  const planned = result.targets[0]!.result;
  assert.equal(planned.items[0]?.uri, preservedMusic.uri);
  assert.equal(planned.items.some((item) => item.type === "PODCAST"), false);
  assert.deepEqual(
    state.evidence.targets[0]?.blockDiagnostics[0]?.diagnosticCodes,
    ["EVENT_PODCAST_PRESERVED_PREFIX"],
  );
  assert.equal(state.evidence.plannerInfluence, true);
});

test("CALENDAR-03 consumes the PODCAST-06 priority projection before duration fit", () => {
  const calendarState = calendar03State();
  const podcast06State = createPodcast06PlannerShadowRuntimeState({
    policies: new Map([
      [
        "show-priority",
        {
          spotifyShowId: "show-priority",
          showName: "Priority",
          cadenceMaxEpisodes: null,
          cadenceUnit: null,
          priority: "PRIORITY" as const,
        },
      ],
    ]),
    listeningStates: [],
    timeZone: "America/Sao_Paulo",
    asOf: new Date("2026-09-09T02:30:00.000Z"),
    requestedMode: "ACTIVE",
    userEmail: EMAIL,
    activeEmailAllowlist: EMAIL,
  });

  const result = runWithPodcast06PlannerShadowRuntimeState(podcast06State, () =>
    runWithCalendar03PlannerRuntimeState(calendarState, () =>
      planRun({
        pools: {
          podcasts: [
            podcast("normal-20", "show-normal", 20),
            podcast("priority-18", "show-priority", 18),
          ],
          music: [music("m12", 12), music("m10", 10)],
        },
        targets: [target()],
      }),
    ),
  );

  assert.equal(result.targets[0]?.result.items[0]?.uri, "spotify:episode:priority-18");
  assert.equal(podcast06State.evidence.plannerInfluence, true);
  assert.equal(calendarState.evidence.plannerInfluence, true);
});
