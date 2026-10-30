import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, PlanRunResult, RunTarget } from "@/services/playlist-planner";

import {
  collectIncrementally,
  type IncrementalCandidateSource,
  type IncrementalSourceBatch,
} from "./incremental-planning";

const MINUTE = 60_000;

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

function music(id: string, minutes: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    spotifyTrackId: id,
    durationMs: minutes * MINUTE,
  };
}

function source(
  id: string,
  kind: "MUSIC" | "PODCAST",
  batches: IncrementalSourceBatch[],
): IncrementalCandidateSource {
  let calls = 0;
  let done = false;
  return {
    id,
    label: id,
    kind,
    get done() {
      return done;
    },
    async readNext() {
      const batch = batches[calls];
      calls += 1;
      if (!batch) throw new Error(`Unexpected read ${calls}`);
      done = batch.done;
      return batch;
    },
  };
}

const target: RunTarget = {
  targetPlaylistId: "work",
  name: "Trabalho",
  priority: 0,
  rules: {
    targetDurationMs: 45 * MINUTE,
    compositionMode: "SEQUENCE",
    podcastPercent: 0,
    sequencePattern: ["PODCAST", "MUSIC"],
    maxEpisodesPerProgram: 1,
  },
};

function plannedPodcastUris(plan: PlanRunResult) {
  return plan.targets[0]!.result.items
    .filter((item) => item.type === "PODCAST")
    .map((item) => item.uri);
}

test("planned podcasts found COMPLETED are dropped and the plan is rebuilt", async () => {
  const completed = new Set(["spotify:episode:old-a", "spotify:episode:old-b"]);
  const checkedPlans: string[][] = [];

  const result = await collectIncrementally({
    sources: [
      source("podcasts", "PODCAST", [
        {
          candidates: [podcast("old-a", 20), podcast("old-b", 20), podcast("fresh", 20)],
          done: true,
        },
      ]),
      source("music", "MUSIC", [
        { candidates: Array.from({ length: 10 }, (_, i) => music(`m${i}`, 5)), done: true },
      ]),
    ],
    targets: [target],
    revalidateBeforeWrite: async () => {},
    findCompletedPlannedPodcasts: async (plan) => {
      const uris = plannedPodcastUris(plan);
      checkedPlans.push(uris);
      return new Set(uris.filter((uri) => completed.has(uri)));
    },
  });

  const finalPodcasts = plannedPodcastUris(result.plan);
  assert.ok(finalPodcasts.includes("spotify:episode:fresh"));
  assert.ok(finalPodcasts.every((uri) => !completed.has(uri)));
  assert.ok(checkedPlans.length >= 2, "must re-check after rebuilding");
  assert.deepEqual(checkedPlans.at(-1), finalPodcasts);
});

test("the completion replan is bounded and returns the plan when it gives up", async () => {
  let calls = 0;
  const result = await collectIncrementally({
    sources: [
      source("podcasts", "PODCAST", [
        {
          candidates: Array.from({ length: 20 }, (_, i) => podcast(`p${i}`, 20)),
          done: true,
        },
      ]),
      source("music", "MUSIC", [
        { candidates: Array.from({ length: 10 }, (_, i) => music(`m${i}`, 5)), done: true },
      ]),
    ],
    targets: [target],
    revalidateBeforeWrite: async () => {},
    findCompletedPlannedPodcasts: async (plan) => {
      calls += 1;
      return new Set(plannedPodcastUris(plan));
    },
  });

  assert.equal(calls, 6);
  assert.ok(result.plan.targets[0]!.result.items.length > 0);
});

test("generation wires the completion replan for simulations and real runs", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const collector = source.indexOf("await collectIncrementally({");
  const wired = source.indexOf("findCompletedPlannedPodcasts,", collector);
  assert.ok(collector >= 0 && wired > collector && wired - collector < 120);
  // The hook must not be gated on `simulate`: simulation and real run must
  // converge on the same plan for the order-hash approval.
  const hookStart = source.indexOf("const findCompletedPlannedPodcasts = async");
  assert.ok(hookStart >= 0 && hookStart < collector);
  assert.doesNotMatch(source.slice(hookStart, collector), /simulate/);
  // The final fail-closed gate before writing stays in place.
  assert.ok(source.indexOf("checkPodcastCompletionBeforeWrite(", collector) > collector);
});
