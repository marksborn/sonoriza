import assert from "node:assert/strict";
import test from "node:test";

import {
  inferInferredSkips,
  type ObservedPlay,
  type PlannedGenerationItem,
} from "./infer-skips";

const APPLIED = new Date("2026-08-14T05:00:00Z");

function music(position: number, id: string): PlannedGenerationItem {
  return {
    position,
    contentType: "MUSIC",
    spotifyTrackId: id,
    spotifyUri: `spotify:track:${id}`,
    generationItemId: `gi-${id}`,
  };
}

function musicWithoutId(position: number): PlannedGenerationItem {
  return {
    position,
    contentType: "MUSIC",
    spotifyTrackId: null,
    spotifyUri: "spotify:local:track",
    generationItemId: `gi-local-${position}`,
  };
}

function podcast(position: number, id: string): PlannedGenerationItem {
  return {
    position,
    contentType: "PODCAST",
    spotifyTrackId: null,
    spotifyUri: `spotify:episode:${id}`,
    generationItemId: `gi-${id}`,
  };
}

/** A play `minutes` after the generation was applied. */
function play(id: string, minutes: number): ObservedPlay {
  return { spotifyTrackId: id, playedAt: new Date(APPLIED.getTime() + minutes * 60_000) };
}

test("regression 1: A✓ B✕ C✓ infers a skip for B", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    plays: [play("A", 1), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });

  assert.equal(result.inferredSkips.length, 1);
  const [skip] = result.inferredSkips;
  assert.equal(skip!.spotifyTrackId, "B");
  assert.equal(skip!.position, 1);
  assert.equal(skip!.confidence, 1);
  assert.equal(skip!.evidence.previousTrackId, "A");
  assert.equal(skip!.evidence.nextTrackId, "C");
});

test("regression 2: A✓ B✓ C✓ infers no skip", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    plays: [play("A", 1), play("B", 1.5), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("regression 3: A✓ B? C? — an unplayed suffix is not a skip", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    plays: [play("A", 1), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("regression 4: A? B✓ C✓ — a leading gap is not a skip", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    plays: [play("B", 1), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("regression 5: A✓ B✕ C✕ D✓ — v1 never infers a multi-track block", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C"), music(3, "D")],
    plays: [play("A", 1), play("D", 2), play("E", 3)],
    latestObservedPlay: play("E", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("regression 6: incoherent anchor order (next played before previous) infers nothing", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    // C played before A — no forward continuity across the candidate.
    plays: [play("C", 1), play("A", 2), play("E", 3)],
    latestObservedPlay: play("E", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("regression 7: a candidate without a stable id is never inferred by name", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), musicWithoutId(1), music(2, "C")],
    plays: [play("A", 1), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});

test("evaluates the music subsequence, ignoring podcasts between tracks", () => {
  // Physical: A -> Podcast X -> B -> C. Music subsequence: A -> B -> C.
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), podcast(1, "X"), music(2, "B"), music(3, "C")],
    plays: [play("A", 1), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 1);
  assert.equal(result.inferredSkips[0]!.spotifyTrackId, "B");
  // Preserves the physical GenerationItem position.
  assert.equal(result.inferredSkips[0]!.position, 2);
});

test("regression 20/22: the most-recent Recently Played track never anchors a skip", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    // C's only continuity play is the most recent — inconclusive this read.
    plays: [play("A", 1), play("C", 2)],
    latestObservedPlay: play("C", 2),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
  assert.equal(result.deferredEdgeTrackId, "C");
});

test("regression 21: a deferred edge track anchors once a newer play exists", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    // A later, newer play (D) means C is no longer the edge.
    plays: [play("A", 1), play("C", 2), play("D", 3)],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 1);
  assert.equal(result.inferredSkips[0]!.spotifyTrackId, "B");
  assert.equal(result.deferredEdgeTrackId, null);
});

test("plays before the generation was applied never anchor an inference", () => {
  const result = inferInferredSkips({
    orderedItems: [music(0, "A"), music(1, "B"), music(2, "C")],
    plays: [
      { spotifyTrackId: "A", playedAt: new Date(APPLIED.getTime() - 60_000) },
      play("C", 2),
      play("D", 3),
    ],
    latestObservedPlay: play("D", 3),
    generationAppliedAt: APPLIED,
  });
  assert.equal(result.inferredSkips.length, 0);
});
