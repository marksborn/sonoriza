import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import {
  collectIncrementally,
  type IncrementalCandidateSource,
  type IncrementalSourceBatch,
} from "./incremental-planning";

const MINUTE = 60_000;

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
  batches: IncrementalSourceBatch[],
): IncrementalCandidateSource & { calls: number } {
  let calls = 0;
  let done = false;
  return {
    id: "music",
    label: "Music",
    kind: "MUSIC",
    get done() {
      return done;
    },
    get calls() {
      return calls;
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

test("CALENDAR-02 incremental collection does not stop while a block still has deficit", async () => {
  const musicSource = source([
    {
      candidates: [music("thirty", 30)],
      done: false,
    },
    {
      candidates: [music("five", 5)],
      done: true,
    },
  ]);

  const target: RunTarget = {
    targetPlaylistId: "target",
    name: "Target",
    priority: 0,
    rules: {
      targetDurationMs: 35 * MINUTE,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },
    durationBlocks: [{ key: "event", targetDurationMs: 35 * MINUTE }],
  };

  const result = await collectIncrementally({
    sources: [musicSource],
    targets: [target],
    revalidateBeforeWrite: async () => {},
  });

  assert.equal(musicSource.calls, 2);
  assert.equal(result.rounds, 2);
  assert.equal(result.plan.targets[0]?.result.stats.segmentation?.deficitMs, 0);
  assert.deepEqual(
    result.plan.targets[0]?.result.items.map((item) => item.uri),
    ["spotify:track:thirty", "spotify:track:five"],
  );
});
