import assert from "node:assert/strict";
import test from "node:test";

import {
  inferSingleTrackSkips,
  type PublishedPreferenceItem,
  type TrackPlaybackObservation,
} from "./music-preference-signals";

const publishedAt = new Date("2026-08-12T18:00:00.000Z");
const observedUntil = new Date("2026-08-12T20:00:00.000Z");

function music(
  position: number,
  id: string,
  durationMs = 180_000,
): PublishedPreferenceItem {
  return {
    id: `item-${id}`,
    position,
    type: "MUSIC",
    uri: `spotify:track:${id}`,
    spotifyTrackId: id,
    durationMs,
  };
}

function podcast(position: number, id: string, durationMs: number): PublishedPreferenceItem {
  return {
    id: `episode-${id}`,
    position,
    type: "PODCAST",
    uri: `spotify:episode:${id}`,
    durationMs,
  };
}

function played(spotifyTrackId: string, iso: string): TrackPlaybackObservation {
  return { spotifyTrackId, lastPlayedAt: new Date(iso) };
}

test("infers a single missing music track between two chronologically observed neighbors", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("C", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.spotifyTrackId, "B");
  assert.equal(result[0]?.signalType, "INFERRED_SKIP");
  assert.equal(result[0]?.position, 1);
  assert.equal(result[0]?.confidence, 0.9);
});

test("does not infer a track that was observed anywhere in the generation window", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("B", "2026-08-12T18:11:00.000Z"),
      played("C", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("does not infer an unplayed trailing suffix because playback may simply have stopped", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C"), music(3, "D")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("B", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("does not infer an unplayed leading prefix", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("B", "2026-08-12T18:10:00.000Z"),
      played("C", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("does not infer a multi-track gap in v1", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C"), music(3, "D")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("D", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("does not infer when observed neighbor timestamps are reversed", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:15:00.000Z"),
      played("C", "2026-08-12T18:12:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("does not infer when the user resumed much later instead of continuing the session", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("C", "2026-08-12T19:10:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("includes interleaved podcast duration in the continuity corridor", () => {
  const result = inferSingleTrackSkips({
    items: [
      music(0, "A", 180_000),
      podcast(1, "P1", 30 * 60_000),
      music(2, "B", 180_000),
      podcast(3, "P2", 10 * 60_000),
      music(4, "C", 180_000),
    ],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("C", "2026-08-12T18:54:00.000Z"),
    ],
  });

  assert.equal(result.length, 1);
  assert.equal(result[0]?.spotifyTrackId, "B");
  assert.equal(result[0]?.plannedCorridorDurationMs, 46 * 60_000);
});

test("requires stable Spotify identity for the candidate and both neighbors", () => {
  const withoutCandidateIdentity: PublishedPreferenceItem = {
    ...music(1, "B"),
    spotifyTrackId: null,
  };

  const result = inferSingleTrackSkips({
    items: [music(0, "A"), withoutCandidateIdentity, music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T18:10:00.000Z"),
      played("C", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});

test("ignores playback observations outside the applied-generation window", () => {
  const result = inferSingleTrackSkips({
    items: [music(0, "A"), music(1, "B"), music(2, "C")],
    publishedAt,
    observedUntil,
    observations: [
      played("A", "2026-08-12T17:59:00.000Z"),
      played("C", "2026-08-12T18:13:00.000Z"),
    ],
  });

  assert.deepEqual(result, []);
});
