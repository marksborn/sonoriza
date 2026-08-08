import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import {
  collectIncrementally,
  type IncrementalCandidateSource,
  type IncrementalSourceBatch,
  type IncrementalSourceKind,
} from "./incremental-planning";

function candidate(
  uri: string,
  kind: IncrementalSourceKind,
  durationMs: number,
  programId?: string,
): Candidate {
  return {
    uri,
    type: kind,
    title: uri,
    durationMs,
    ...(kind === "PODCAST" ? { programId: programId ?? uri } : {}),
  };
}

function target(durationMs = 600_000): RunTarget {
  return {
    targetPlaylistId: "target-a",
    name: "Target A",
    priority: 0,
    rules: {
      targetDurationMs: durationMs,
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
  };
}

function fakeSource(input: {
  id: string;
  kind: IncrementalSourceKind;
  batches: Array<IncrementalSourceBatch | Error>;
}): IncrementalCandidateSource & { calls: number } {
  let done = false;
  let calls = 0;

  return {
    id: input.id,
    label: input.id,
    kind: input.kind,
    get done() {
      return done;
    },
    get calls() {
      return calls;
    },
    async readNext() {
      const batch = input.batches[calls];
      calls += 1;
      if (!batch) throw new Error(`Unexpected read ${calls} for ${input.id}`);
      if (batch instanceof Error) throw batch;
      done = batch.done;
      return batch;
    },
  };
}

test("stops after the first 50-item-sized round when the plan already passes", async () => {
  const music = fakeSource({
    id: "music",
    kind: "MUSIC",
    batches: [
      {
        candidates: [candidate("spotify:track:1", "MUSIC", 300_000)],
        done: false,
      },
      {
        candidates: [candidate("spotify:track:2", "MUSIC", 300_000)],
        done: true,
      },
    ],
  });
  const podcast = fakeSource({
    id: "podcast",
    kind: "PODCAST",
    batches: [
      {
        candidates: [candidate("spotify:episode:1", "PODCAST", 300_000, "show-1")],
        done: false,
      },
      {
        candidates: [candidate("spotify:episode:2", "PODCAST", 300_000, "show-2")],
        done: true,
      },
    ],
  });

  const result = await collectIncrementally({
    sources: [music, podcast],
    targets: [target()],
  });

  assert.equal(result.qualityFailures.length, 0);
  assert.equal(result.rounds, 1);
  assert.equal(result.stoppedEarly, true);
  assert.equal(music.calls, 1);
  assert.equal(podcast.calls, 1);
});

test("after replanning, advances only the source kind that is still short", async () => {
  const music = fakeSource({
    id: "music",
    kind: "MUSIC",
    batches: [
      {
        candidates: [candidate("spotify:track:1", "MUSIC", 300_000)],
        done: false,
      },
      {
        candidates: [candidate("spotify:track:2", "MUSIC", 300_000)],
        done: true,
      },
    ],
  });
  const podcast = fakeSource({
    id: "podcast",
    kind: "PODCAST",
    batches: [
      {
        candidates: [candidate("spotify:episode:1", "PODCAST", 100_000, "show-1")],
        done: false,
      },
      {
        candidates: [candidate("spotify:episode:2", "PODCAST", 200_000, "show-2")],
        done: false,
      },
      {
        candidates: [candidate("spotify:episode:3", "PODCAST", 300_000, "show-3")],
        done: true,
      },
    ],
  });

  const result = await collectIncrementally({
    sources: [music, podcast],
    targets: [target()],
  });

  assert.equal(result.qualityFailures.length, 0);
  assert.equal(music.calls, 1);
  assert.ok(podcast.calls > 1);
});

test("returns the exact source failure instead of planning with a known partial pool", async () => {
  const music = fakeSource({
    id: "music",
    kind: "MUSIC",
    batches: [
      {
        candidates: [candidate("spotify:track:1", "MUSIC", 300_000)],
        done: true,
      },
    ],
  });
  const podcast = fakeSource({
    id: "podcast",
    kind: "PODCAST",
    batches: [new Error("quota")],
  });

  const result = await collectIncrementally({
    sources: [music, podcast],
    targets: [target()],
  });

  assert.equal(result.failure?.source.id, "podcast");
  assert.match(String(result.failure?.error), /quota/);
  assert.equal(result.qualityFailures.length > 0, true);
});

test("exhausts the necessary kind before declaring a conclusive quality failure", async () => {
  const music = fakeSource({
    id: "music",
    kind: "MUSIC",
    batches: [
      {
        candidates: [candidate("spotify:track:1", "MUSIC", 300_000)],
        done: true,
      },
    ],
  });
  const podcast = fakeSource({
    id: "podcast",
    kind: "PODCAST",
    batches: [
      {
        candidates: [candidate("spotify:episode:1", "PODCAST", 30_000, "show-1")],
        done: false,
      },
      {
        candidates: [candidate("spotify:episode:2", "PODCAST", 30_000, "show-2")],
        done: true,
      },
    ],
  });

  const result = await collectIncrementally({
    sources: [music, podcast],
    targets: [target()],
  });

  assert.equal(result.failure, null);
  assert.equal(result.qualityFailures.length, 1);
  assert.equal(podcast.calls, 2);
});

test("a filtered unavailable music slot does not count and a later playable substitute can fill it", async () => {
  const music = fakeSource({ id: "music-filtered", kind: "MUSIC", batches: [
    { candidates: [], done: false, unavailableMusicSkippedCount: 1 },
    { candidates: [candidate("spotify:track:replacement", "MUSIC", 300_000)], done: true },
  ]});
  const podcast = fakeSource({ id: "podcast-filtered", kind: "PODCAST", batches: [
    { candidates: [candidate("spotify:episode:replacement", "PODCAST", 300_000, "show-r")], done: true },
  ]});
  const result = await collectIncrementally({ sources: [music, podcast], targets: [target()] });
  assert.equal(result.qualityFailures.length, 0); assert.equal(music.calls, 2); assert.equal(result.pools.music.length, 1);
});

test("an exhausted music pool after filtering surfaces real shortfall instead of a fake sequence pass", async () => {
  const music = fakeSource({ id: "music-unavailable", kind: "MUSIC", batches: [{ candidates: [], done: true, unavailableMusicSkippedCount: 2 }] });
  const podcast = fakeSource({ id: "podcast-available", kind: "PODCAST", batches: [{ candidates: [candidate("spotify:episode:only", "PODCAST", 300_000, "show-only")], done: true }] });
  const result = await collectIncrementally({ sources: [music, podcast], targets: [target()] });
  assert.equal(result.qualityFailures.length, 1); assert.ok((result.qualityFailures[0]?.result.stats.musicShortfallMs ?? 0) > 0);
});

test("music deduplication by URI remains correct after eligibility filtering", async () => {
  const duplicate = candidate("spotify:track:same", "MUSIC", 300_000);
  const musicA = fakeSource({ id: "music-a", kind: "MUSIC", batches: [{ candidates: [duplicate], done: true }] });
  const musicB = fakeSource({ id: "music-b", kind: "MUSIC", batches: [{ candidates: [duplicate], done: true }] });
  const podcast = fakeSource({ id: "podcast-dedupe", kind: "PODCAST", batches: [{ candidates: [candidate("spotify:episode:dedupe", "PODCAST", 300_000, "show-d")], done: true }] });
  const result = await collectIncrementally({ sources: [musicA, musicB, podcast], targets: [target()] });
  assert.equal(result.pools.music.length, 1); assert.equal(result.pools.music[0]?.uri, "spotify:track:same");
});
