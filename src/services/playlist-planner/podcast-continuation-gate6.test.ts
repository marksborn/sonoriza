import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createPodcast09ShadowRuntimeState,
  podcast09ShadowRuntimeSummary,
  resolvePodcast09PlannerMode,
  runWithPodcast09ShadowRuntimeState,
} from "./podcast-continuation-shadow-runtime";
import { planRun } from "./plan-run-podcast09";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;
const USER_ID = "user-1";
const TARGET_ID = "trabalho";
const OTHER_TARGET_ID = "carro";
const ACTIVE_PAIR = `${USER_ID}:${TARGET_ID}`;

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    durationMs: 3 * MINUTE,
  };
}

function podcast(
  id: string,
  status: "NOT_STARTED" | "IN_PROGRESS" = "NOT_STARTED",
): Candidate {
  return {
    uri: `spotify:episode:${id}`,
    type: "PODCAST",
    title: id,
    spotifyEpisodeId: id,
    programId: `show:${id}`,
    durationMs: 20 * MINUTE,
    podcastListeningStatus: status,
  };
}

function rules(): PlaylistRules {
  return {
    targetDurationMs: 23 * MINUTE,
    compositionMode: "SEQUENCE",
    podcastPercent: 60,
    sequencePattern: ["MUSIC", "PODCAST"],
    maxEpisodesPerProgram: 1,
    maxPodcastDurationMs: null,
    maxTracksPerArtist: null,
    maxTracksPerAlbum: null,
  };
}

function input() {
  return {
    pools: {
      music: [music("song")],
      podcasts: [podcast("new"), podcast("resume", "IN_PROGRESS")],
    },
    targets: [
      {
        targetPlaylistId: TARGET_ID,
        name: "Trabalho",
        priority: 0,
        rules: rules(),
      },
    ],
  };
}

function plannedPodcastIds(result: ReturnType<typeof planRun>): string[] {
  return result.targets[0]!.result.items.flatMap((item) =>
    item.type === "PODCAST" && item.spotifyEpisodeId ? [item.spotifyEpisodeId] : [],
  );
}

test("Gate 6 allows SCHEDULED ACTIVE only with the third exact pair allowlist", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "SCHEDULED",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
    scheduledActiveAllowlist: ACTIVE_PAIR,
  });

  assert.deepEqual(mode, {
    requestedMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    activationReason: "ACTIVE_SCHEDULED_ALLOWED",
  });
});

test("Gate 6 keeps SCHEDULED fail-closed without the third allowlist", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "SCHEDULED",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_MANUAL_ONLY");
});

test("Gate 6 scheduled allowlist is exact-pair scoped", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "SCHEDULED",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
    scheduledActiveAllowlist: `${USER_ID}:${OTHER_TARGET_ID}`,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_MANUAL_ONLY");
});

test("Gate 6 does not change Gate 5 MANUAL activation", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "MANUAL",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
  });

  assert.deepEqual(mode, {
    requestedMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    activationReason: "ACTIVE_REAL_ALLOWED",
  });
});

test("Gate 6 keeps SIMULATION activation independent from real scheduled authorization", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: true,
    trigger: "SIMULATION",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
  });

  assert.deepEqual(mode, {
    requestedMode: "ACTIVE",
    effectiveMode: "ACTIVE",
    activationReason: "ACTIVE_ALLOWED",
  });
});

test("Gate 6 remains fail-closed for multi-target scheduled runs", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "SCHEDULED",
    userId: USER_ID,
    targetScope: [TARGET_ID, OTHER_TARGET_ID],
    targetAllowlist: `${TARGET_ID},${OTHER_TARGET_ID}`,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
    scheduledActiveAllowlist: ACTIVE_PAIR,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_SINGLE_TARGET_REQUIRED");
});

test("Gate 6 remains fail-closed for unsupported real triggers", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "RETRY",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
    scheduledActiveAllowlist: ACTIVE_PAIR,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_MANUAL_ONLY");
});

test("Gate 6 exact SCHEDULED activation returns the continuation plan", () => {
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist: TARGET_ID,
    currentDestinationEpisodeIdsByTargetId: {
      [TARGET_ID]: ["resume"],
    },
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "SCHEDULED",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
    scheduledActiveAllowlist: ACTIVE_PAIR,
  });

  const result = runWithPodcast09ShadowRuntimeState(state, () => planRun(input()));

  assert.deepEqual(plannedPodcastIds(result), ["resume"]);
  const summary = podcast09ShadowRuntimeSummary(state);
  assert.equal(summary.requestedMode, "ACTIVE");
  assert.equal(summary.effectiveMode, "ACTIVE");
  assert.equal(summary.activationReason, "ACTIVE_SCHEDULED_ALLOWED");
  assert.equal(summary.plannerInfluence, true);
  assert.equal(summary.simulation, false);
  assert.equal(summary.trigger, "SCHEDULED");
  assert.equal(summary.addedProviderCalls, false);
  assert.equal(summary.behavioralDatabaseWrites, false);
  assert.equal(summary.observabilitySummaryWrite, true);
  assert.equal(summary.continuationInfluencedSpotifyWritePossible, true);

  const evidence = summary.targets[0]!;
  assert.equal(evidence.plannerInfluence, true);
  assert.equal(evidence.selectedEpisodeId, "resume");
  assert.equal(evidence.projectedFirstPodcastEpisodeId, "resume");
});

test("Gate 6 generation wrapper wires a separate SCHEDULED ACTIVE allowlist", () => {
  const source = readFileSync("src/jobs/generate-playlists-podcast09.ts", "utf8");

  assert.match(source, /PODCAST_09_SCHEDULED_ACTIVE_ALLOWLIST/);
  assert.match(
    source,
    /scheduledActiveAllowlist:\s*process\.env\.PODCAST_09_SCHEDULED_ACTIVE_ALLOWLIST/,
  );
  assert.match(source, /trigger: opts\.trigger/);
});
