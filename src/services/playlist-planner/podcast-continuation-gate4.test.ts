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

test("Gate 4 resolves ACTIVE only for an exact allowlisted single-target simulation", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: true,
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

test("Gate 4 downgrades ACTIVE real runs to SHADOW without the Gate 5 real allowlist", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: false,
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: ACTIVE_PAIR,
  });

  assert.equal(mode.requestedMode, "ACTIVE");
  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_SIMULATION_ONLY");
});

test("Gate 4 downgrades ACTIVE when the exact user-target pair is absent", () => {
  const mode = resolvePodcast09PlannerMode({
    requestedMode: "ACTIVE",
    simulate: true,
    userId: USER_ID,
    targetScope: [TARGET_ID],
    targetAllowlist: TARGET_ID,
    activeAllowlist: `other-user:${TARGET_ID}`,
  });

  assert.equal(mode.effectiveMode, "SHADOW");
  assert.equal(mode.activationReason, "ACTIVE_PAIR_NOT_ALLOWED");
});

test("Gate 4 ACTIVE simulation returns the destination-local continuation plan", () => {
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist: TARGET_ID,
    currentDestinationEpisodeIdsByTargetId: {
      [TARGET_ID]: ["resume"],
    },
    requestedMode: "ACTIVE",
    simulate: true,
    trigger: "SIMULATION",
    userId: USER_ID,
    targetScope: [TARGET_ID],
    activeAllowlist: ACTIVE_PAIR,
  });

  const result = runWithPodcast09ShadowRuntimeState(state, () => planRun(input()));

  assert.deepEqual(plannedPodcastIds(result), ["resume"]);
  const summary = podcast09ShadowRuntimeSummary(state);
  assert.equal(summary.requestedMode, "ACTIVE");
  assert.equal(summary.effectiveMode, "ACTIVE");
  assert.equal(summary.activationReason, "ACTIVE_ALLOWED");
  assert.equal(summary.plannerInfluence, true);
  assert.equal(summary.simulation, true);
  assert.equal(summary.continuationInfluencedSpotifyWritePossible, false);

  const evidence = summary.targets[0]!;
  assert.equal(evidence.status, "SHADOW_READY");
  assert.equal(evidence.plannerInfluence, true);
  assert.equal(evidence.selectedEpisodeId, "resume");
  assert.equal(evidence.currentFirstPodcastEpisodeId, "new");
  assert.equal(evidence.projectedFirstPodcastEpisodeId, "resume");
  assert.equal(evidence.planChanged, true);
});

test("Gate 4 downgraded real run keeps the existing authoritative plan", () => {
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
  });

  const result = runWithPodcast09ShadowRuntimeState(state, () => planRun(input()));

  assert.deepEqual(plannedPodcastIds(result), ["new"]);
  const summary = podcast09ShadowRuntimeSummary(state);
  assert.equal(summary.effectiveMode, "SHADOW");
  assert.equal(summary.activationReason, "ACTIVE_SIMULATION_ONLY");
  assert.equal(summary.plannerInfluence, false);
  assert.equal(summary.targets[0]!.plannerInfluence, false);
});

test("Gate 4 generation wrapper wires explicit mode and exact ACTIVE allowlist", () => {
  const source = readFileSync("src/jobs/generate-playlists-podcast09.ts", "utf8");

  assert.match(source, /PODCAST_09_PLANNER_MODE/);
  assert.match(source, /PODCAST_09_SHADOW_TARGET_ALLOWLIST/);
  assert.match(source, /PODCAST_09_ACTIVE_ALLOWLIST/);
  assert.match(source, /simulate = opts\.simulate \?\? opts\.trigger === "SIMULATION"/);
  assert.match(source, /activeAllowlist: process\.env\.PODCAST_09_ACTIVE_ALLOWLIST/);
});
