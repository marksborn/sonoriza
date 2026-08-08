import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildMusicSourceCleanupPlan,
  hashCleanupPlan,
  type PlaylistCleanupOccurrence,
} from "./source-cleanup";

function occurrence(
  uri: string | null,
  aliases: string[],
  options: Partial<Pick<PlaylistCleanupOccurrence, "isTrack" | "isLocal">> = {},
): PlaylistCleanupOccurrence {
  return {
    uri,
    aliases,
    isTrack: options.isTrack ?? true,
    isLocal: options.isLocal ?? false,
  };
}

test("never removes a track without persisted playback history", () => {
  const plan = buildMusicSourceCleanupPlan(
    [occurrence("spotify:track:a", ["a"])],
    new Set(),
  );

  assert.equal(plan.examinedCount, 1);
  assert.equal(plan.removableTrackCount, 0);
  assert.equal(plan.removalOccurrenceCount, 0);
  assert.equal(plan.keptCount, 1);
  assert.deepEqual(plan.removableUris, []);
});

test("a played track becomes removable", () => {
  const plan = buildMusicSourceCleanupPlan(
    [
      occurrence("spotify:track:a", ["a"]),
      occurrence("spotify:track:b", ["b"]),
    ],
    new Set(["a"]),
  );

  assert.deepEqual(plan.removableUris, ["spotify:track:a"]);
  assert.equal(plan.removableTrackCount, 1);
  assert.equal(plan.removalOccurrenceCount, 1);
  assert.equal(plan.keptCount, 1);
});

test("all duplicate occurrences are accounted for while DELETE plan stays unique by URI", () => {
  const plan = buildMusicSourceCleanupPlan(
    [
      occurrence("spotify:track:a", ["a"]),
      occurrence("spotify:track:a", ["a"]),
      occurrence("spotify:track:b", ["b"]),
    ],
    new Set(["a"]),
  );

  assert.deepEqual(plan.removableUris, ["spotify:track:a"]);
  assert.equal(plan.removableTrackCount, 1);
  assert.equal(plan.removalOccurrenceCount, 2);
  assert.equal(plan.keptCount, 1);
});

test("Track Relinking alias can prove playback without name matching", () => {
  const plan = buildMusicSourceCleanupPlan(
    [occurrence("spotify:track:effective", ["effective", "original"])],
    new Set(["original"]),
  );

  assert.deepEqual(plan.removableUris, ["spotify:track:effective"]);
});

test("local items, episodes and missing identities are never removed by cleanup planning", () => {
  const plan = buildMusicSourceCleanupPlan(
    [
      occurrence("spotify:track:local", ["local"], { isLocal: true }),
      occurrence("spotify:episode:e", ["e"], { isTrack: false }),
      occurrence("spotify:track:unknown", []),
    ],
    new Set(["local", "e"]),
  );

  assert.equal(plan.removableTrackCount, 0);
  assert.equal(plan.keptCount, 3);
});

test("plan hash is deterministic but changes when duplicate occurrence count changes", () => {
  const left = hashCleanupPlan(
    ["spotify:track:b", "spotify:track:a"],
    2,
  );
  const reordered = hashCleanupPlan(
    ["spotify:track:a", "spotify:track:b"],
    2,
  );
  const differentOccurrences = hashCleanupPlan(
    ["spotify:track:a", "spotify:track:b"],
    3,
  );

  assert.equal(left, reordered);
  assert.notEqual(left, differentOccurrences);
});

test("Spotify mutation contract uses the 2026 items endpoint, snapshot guard and 100 item batches", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");

  assert.match(source, /MAX_DELETE_ITEMS = 100/);
  assert.match(source, /`\/playlists\/\$\{preview\.source\.spotifyId\}\/items`/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /snapshot_id: snapshotAfter/);
  assert.doesNotMatch(source, /\/tracks["`?]/);
});

test("periodic cleanup remains gated behind explicit automation and a completed first cleanup", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");

  assert.match(source, /!source\.musicCleanupAutomationEnabled/);
  assert.match(source, /!source\.musicCleanupFirstCompletedAt/);
  assert.match(source, /A limpeza periódica não está autorizada/);
});
