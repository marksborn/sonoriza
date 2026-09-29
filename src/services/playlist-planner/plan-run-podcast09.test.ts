import assert from "node:assert/strict";
import test from "node:test";

import {
  createPodcast09ShadowRuntimeState,
  podcast09ShadowRuntimeSummary,
  runWithPodcast09ShadowRuntimeState,
} from "./podcast-continuation-shadow-runtime";
import { planRun } from "./plan-run-podcast09";
import type { Candidate, PlaylistRules } from "./types";

const MINUTE = 60_000;
const TARGET_ID = "trabalho";

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

test("Gate 3 records projected continuation but returns the existing authoritative plan", () => {
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist: TARGET_ID,
    listeningStates: [
      {
        spotifyEpisodeId: "resume",
        status: "IN_PROGRESS",
        lastObservedAt: new Date("2026-09-29T10:00:00Z"),
        firstProgressObservedAt: new Date("2026-09-28T10:00:00Z"),
      },
    ],
  });

  const result = runWithPodcast09ShadowRuntimeState(state, () =>
    planRun({
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
    }),
  );

  const authoritativePodcastIds = result.targets[0]!.result.items.flatMap((item) =>
    item.type === "PODCAST" && item.spotifyEpisodeId ? [item.spotifyEpisodeId] : [],
  );
  assert.deepEqual(authoritativePodcastIds, ["new"]);

  const evidence = podcast09ShadowRuntimeSummary(state).targets[0]!;
  assert.equal(evidence.status, "SHADOW_READY");
  assert.equal(evidence.plannerInfluence, false);
  assert.equal(evidence.selectedEpisodeId, "resume");
  assert.equal(evidence.currentFirstPodcastEpisodeId, "new");
  assert.equal(evidence.projectedFirstPodcastEpisodeId, "resume");
  assert.equal(evidence.currentSelectedPlanPosition, null);
  assert.equal(evidence.projectedSelectedPlanPosition, 1);
  assert.equal(evidence.planChanged, true);
});

test("Gate 3 abstains from multi-target runs instead of projecting cross-target side effects", () => {
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist: TARGET_ID,
    listeningStates: [],
  });

  runWithPodcast09ShadowRuntimeState(state, () =>
    planRun({
      pools: {
        music: [music("song-a"), music("song-b")],
        podcasts: [podcast("new")],
      },
      targets: [
        {
          targetPlaylistId: TARGET_ID,
          name: "Trabalho",
          priority: 0,
          rules: rules(),
        },
        {
          targetPlaylistId: "other",
          name: "Outro",
          priority: 1,
          rules: rules(),
        },
      ],
    }),
  );

  const evidence = podcast09ShadowRuntimeSummary(state).targets[0]!;
  assert.equal(evidence.status, "ABSTAIN_MULTI_TARGET_SCOPE");
  assert.equal(evidence.plannerInfluence, false);
});
