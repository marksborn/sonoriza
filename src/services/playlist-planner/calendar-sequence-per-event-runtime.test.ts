import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCalendarEventCompositionPolicy,
  type CalendarEventCompositionPolicyInput,
} from "../calendar-event-composition-policy";
import {
  calendar03PlannerRuntimeSummary,
  calendar03TargetOwnsComposition,
  createCalendar03PlannerRuntimeState,
  resolveCalendar04PlannerMode,
  runWithCalendar03PlannerRuntimeState,
} from "./calendar-event-composition-runtime";
import { planRun } from "./plan-run-calendar03";
import { planRun as basePlanRun } from "./plan-run";
import type { Candidate, PlanRunInput, RunTarget } from "./index";

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

function podcast(id: string, minutes: number): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: minutes * MINUTE,
    podcastListeningStatus: "NOT_STARTED",
  };
}

function target(): RunTarget {
  return {
    targetPlaylistId: TARGET,
    name: "Carro",
    priority: 0,
    durationBlocks: [
      { key: "IDA", targetDurationMs: 30 * MINUTE },
      { key: "VOLTA", targetDurationMs: 30 * MINUTE },
    ],
    rules: {
      targetDurationMs: 60 * MINUTE,
      compositionMode: "SEQUENCE",
      podcastPercent: 0,
      sequencePattern: ["PODCAST", "MUSIC"],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

function input(overrides: Partial<PlanRunInput> = {}): PlanRunInput {
  return {
    targets: [target()],
    pools: {
      podcasts: [podcast("p1", 20), podcast("p2", 20)],
      music: Array.from({ length: 30 }, (_, index) => music(`m${index}`, 5)),
    },
    ...overrides,
  };
}

function state(
  calendar04RequestedMode: string | null,
  policyInput: Partial<CalendarEventCompositionPolicyInput> = {},
) {
  return createCalendar03PlannerRuntimeState({
    policies: new Map([
      [
        TARGET,
        normalizeCalendarEventCompositionPolicy(TARGET, {
          eventCompositionPolicy: "SEQUENCE_PER_EVENT",
          maxPodcastsPerEvent: 1,
          podcastEventSafetyMarginSeconds: 0,
          podcastEventDistribution: "EVERY_EVENT",
          remainderFillStrategy: "MUSIC_ONLY",
          ...policyInput,
        }),
      ],
    ]),
    requestedMode: "ACTIVE",
    userEmail: EMAIL,
    activeEmailAllowlist: EMAIL,
    activeTargetIds: TARGET,
    calendar04RequestedMode,
  });
}

function blockTypes(result: ReturnType<typeof planRun>, blockIndex: number) {
  return result.targets[0]!.result.items
    .filter((item) => item.planningBlockIndex === blockIndex)
    .map((item) => item.type);
}

test("CALENDAR-04 mode needs its own ACTIVE switch on top of CALENDAR-03", () => {
  assert.equal(resolveCalendar04PlannerMode(undefined, "ACTIVE").effectiveMode, "SHADOW");
  assert.equal(resolveCalendar04PlannerMode("bogus", "ACTIVE").effectiveMode, "SHADOW");
  assert.equal(resolveCalendar04PlannerMode("ACTIVE", "SHADOW").effectiveMode, "SHADOW");
  assert.equal(resolveCalendar04PlannerMode("ACTIVE", "OFF").effectiveMode, "OFF");
  assert.equal(resolveCalendar04PlannerMode("OFF", "ACTIVE").effectiveMode, "OFF");
  assert.equal(resolveCalendar04PlannerMode("active", "ACTIVE").effectiveMode, "ACTIVE");
});

test("SHADOW keeps the exact legacy plan and records per-event evidence", () => {
  const runtime = state("SHADOW");
  const result = runWithCalendar03PlannerRuntimeState(runtime, () => planRun(input()));
  const legacy = basePlanRun(input());

  assert.deepEqual(
    result.targets[0]!.result.items.map((item) => item.uri),
    legacy.targets[0]!.result.items.map((item) => item.uri),
  );
  const summary = calendar03PlannerRuntimeSummary(runtime);
  assert.equal(summary.calendar04EffectiveMode, "SHADOW");
  const evidence = summary.targets[0]!;
  assert.equal(evidence.status, "READY_SHADOW");
  assert.equal(evidence.plannerInfluence, false);
  assert.equal(evidence.blockDiagnostics.length, 2);
  assert.equal(evidence.blockDiagnostics[0]!.calendar04?.remainderFillStrategy, "MUSIC_ONLY");
  assert.equal(calendar03TargetOwnsComposition(runtime, TARGET), false);
});

test("ACTIVE replaces the plan: both events start with the sequence", () => {
  const runtime = state("ACTIVE");
  const result = runWithCalendar03PlannerRuntimeState(runtime, () => planRun(input()));

  assert.deepEqual(blockTypes(result, 0).slice(0, 2), ["PODCAST", "MUSIC"]);
  assert.deepEqual(blockTypes(result, 1).slice(0, 2), ["PODCAST", "MUSIC"]);
  assert.equal(calendar03TargetOwnsComposition(runtime, TARGET), true);
  const blocks = result.targets[0]!.result.stats.segmentation?.blocks ?? [];
  assert.equal(blocks.length, 2);
  for (const block of blocks) assert.ok(block.filledDurationMs <= block.targetDurationMs);
});

test("ACTIVE abstains to the legacy plan when KEEP_FILLED preserved items exist", () => {
  const runtime = state("ACTIVE");
  const preserved = [music("kept", 5)];
  const runInput = input({ preservedByTargetId: new Map([[TARGET, preserved]]) });
  const result = runWithCalendar03PlannerRuntimeState(runtime, () => planRun(runInput));
  const legacy = basePlanRun(runInput);

  assert.deepEqual(
    result.targets[0]!.result.items.map((item) => item.uri),
    legacy.targets[0]!.result.items.map((item) => item.uri),
  );
  const evidence = calendar03PlannerRuntimeSummary(runtime).targets[0]!;
  assert.equal(evidence.status, "ABSTAIN_PRESERVED_ITEMS");
  assert.equal(calendar03TargetOwnsComposition(runtime, TARGET), false);
});

test("legacy PODCAST_THEN_MUSIC evidence keeps its shape without CALENDAR-04 keys", () => {
  const runtime = createCalendar03PlannerRuntimeState({
    policies: new Map([
      [
        TARGET,
        normalizeCalendarEventCompositionPolicy(TARGET, {
          eventCompositionPolicy: "PODCAST_THEN_MUSIC",
          maxPodcastsPerEvent: 1,
          podcastEventSafetyMarginSeconds: 0,
          podcastEventDistribution: "EVERY_N_EVENTS",
          podcastEveryNEvents: 2,
          podcastEventOffset: 0,
        }),
      ],
    ]),
    requestedMode: "SHADOW",
    calendar04RequestedMode: "ACTIVE",
  });
  runWithCalendar03PlannerRuntimeState(runtime, () => planRun(input()));
  const summary = calendar03PlannerRuntimeSummary(runtime);

  assert.equal("calendar04EffectiveMode" in summary, false);
  assert.equal("calendar04" in summary.targets[0]!.blockDiagnostics[0]!, false);
  assert.equal("sequencePerEvent" in summary.targets[0]!.policy, false);
});
