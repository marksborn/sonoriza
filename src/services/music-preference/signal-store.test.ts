import assert from "node:assert/strict";
import test from "node:test";

import type { InferredSkip } from "./infer-skips";
import { createVolatileMusicPreferenceSignalStore } from "./signal-store";

function skip(trackId: string, position: number): InferredSkip {
  return {
    spotifyTrackId: trackId,
    spotifyUri: `spotify:track:${trackId}`,
    position,
    generationItemId: `gi-${trackId}`,
    confidence: 1,
    evidence: {
      previousTrackId: "prev",
      previousPlayedAt: "2026-08-14T05:01:00.000Z",
      nextTrackId: "next",
      nextPlayedAt: "2026-08-14T05:02:00.000Z",
      previousPosition: position - 1,
      position,
      nextPosition: position + 1,
    },
  };
}

test("regression 9: re-recording the same generation/position is idempotent", async () => {
  const store = createVolatileMusicPreferenceSignalStore();
  const input = {
    userId: "user-1",
    sourceGenerationRunId: "run-1",
    targetPlaylistId: "target-A",
    skips: [skip("B", 1)],
  };

  const first = await store.recordInferredSkips(input);
  const second = await store.recordInferredSkips(input);

  assert.deepEqual(first, { created: 1, duplicates: 0 });
  assert.deepEqual(second, { created: 0, duplicates: 1 });
  assert.equal((await store.listPendingSkips("user-1", "target-A")).length, 1);
});

test("regression 13: a signal for target A does not surface for target B", async () => {
  const store = createVolatileMusicPreferenceSignalStore();
  await store.recordInferredSkips({
    userId: "user-1",
    sourceGenerationRunId: "run-1",
    targetPlaylistId: "target-A",
    skips: [skip("B", 1)],
  });

  const pendingA = await store.listPendingSkips("user-1", "target-A");
  const pendingB = await store.listPendingSkips("user-1", "target-B");

  assert.deepEqual(
    pendingA.map((row) => row.spotifyTrackId),
    ["B"],
  );
  assert.deepEqual(pendingB, []);
});

test("regression 16/17: consuming a signal removes it from pending and is one-shot", async () => {
  const store = createVolatileMusicPreferenceSignalStore();
  await store.recordInferredSkips({
    userId: "user-1",
    sourceGenerationRunId: "run-1",
    targetPlaylistId: "target-A",
    skips: [skip("B", 1)],
  });

  const [pending] = await store.listPendingSkips("user-1", "target-A");
  const consumed = await store.consume(
    "user-1",
    [pending!.id],
    "run-2",
    new Date("2026-08-14T06:00:00Z"),
  );
  assert.equal(consumed, 1);

  // No longer suppresses later generations.
  assert.deepEqual(await store.listPendingSkips("user-1", "target-A"), []);

  // Consuming again is a no-op (already consumed).
  const again = await store.consume(
    "user-1",
    [pending!.id],
    "run-3",
    new Date("2026-08-14T07:00:00Z"),
  );
  assert.equal(again, 0);
});

test("recording an empty batch does nothing", async () => {
  const store = createVolatileMusicPreferenceSignalStore();
  const result = await store.recordInferredSkips({
    userId: "user-1",
    sourceGenerationRunId: "run-1",
    targetPlaylistId: "target-A",
    skips: [],
  });
  assert.deepEqual(result, { created: 0, duplicates: 0 });
});
