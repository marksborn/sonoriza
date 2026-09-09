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

test("ACTIVE with preserved items fails closed instead of reinterpreting KEEP_FILLED", () => {
  const state = calendar03State();
  runWithCalendar03PlannerRuntimeState(state, () =>
    planRun({
      pools: {
        podcasts: [podcast("p20", "show-a", 20)],
        music: [music("m10", 10)],
      },
      targets: [target()],
      preservedByTargetId: new Map([
        [TARGET, [music("preserved", 5)]],
      ]),
    }),
  );

  assert.equal(state.evidence.plannerInfluence, false);
  assert.equal(state.evidence.targets[0]?.status, "ABSTAIN_PRESERVED_ITEMS");
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
