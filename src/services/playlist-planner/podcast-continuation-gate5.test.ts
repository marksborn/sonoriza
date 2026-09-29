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

test("Gate 5 allows ACTIVE real only for an exact double-allowlisted MANUAL single-target run", () => {
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

test("Gate 5 keeps real ACTIVE fail-closed when the second real allowlist is absent", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "MANUAL",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_SIMULATION_ONLY");
});

test("Gate 5 never activates a SCHEDULED real run even with both exact allowlists", () => {
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

test("Gate 5 exact MANUAL real activation returns the continuation plan", () => {
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist: TARGET_ID,
    currentDestinationEpisodeIdsByTargetId: {
      [TARGET_ID]: ["resume"],
    },
    requestedMode: "ACTIVE",
    simulate: false,
    trigger: "MANUAL",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    activeAllowlist: ACTIVE_PAIR,
    realActiveAllowlist: ACTIVE_PAIR,
  });

  const result = runWithPodcast09ShadowRuntimeState(state, () => planRun(input()));

  assert.deepEqual(plannedPodcastIds(result), ["resume"]);
  const summary = podcast09ShadowRuntimeSummary(state);
  assert.equal(summary.runtimeVersion, "podcast09-gate5-runtime-v1");
  assert.equal(summary.requestedMode, "ACTIVE");
  assert.equal(summary.effectiveMode, "ACTIVE");
  assert.equal(summary.activationReason, "ACTIVE_REAL_ALLOWED");
  assert.equal(summary.plannerInfluence, true);
  assert.equal(summary.simulation, false);
  assert.equal(summary.trigger, "MANUAL");
  assert.equal(summary.addedProviderCalls, false);
  assert.equal(summary.behavioralDatabaseWrites, false);
  assert.equal(summary.observabilitySummaryWrite, true);
  assert.equal(summary.continuationInfluencedSpotifyWritePossible, true);

  const evidence = summary.targets[0]!;
  assert.equal(evidence.plannerInfluence, true);
  assert.equal(evidence.selectedEpisodeId, "resume");
  assert.equal(evidence.projectedFirstPodcastEpisodeId, "resume");
});

test("Gate 5 simulation contract stays ACTIVE without the real allowlist", () => {
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

test("Gate 5 generation wrapper requires a separate real ACTIVE allowlist and forwards trigger", () => {
  const source = readFileSync("src/jobs/generate-playlists-podcast09.ts", "utf8");

  assert.match(source, /PODCAST_09_REAL_ACTIVE_ALLOWLIST/);
  assert.match(source, /trigger: opts\.trigger/);
  assert.match(
    source,
    /realActiveAllowlist: process\.env\.PODCAST_09_REAL_ACTIVE_ALLOWLIST/,
  );
});
