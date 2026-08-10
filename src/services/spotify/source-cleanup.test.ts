import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCachedMusicSourceCleanupPlan,
  buildMusicSourceCleanupPlan,
  classifyPostDeleteDiagnosis,
  hashCleanupPlan,
  type PlaylistCleanupOccurrence,
} from "./source-cleanup";
import { MusicSourceCleanupStatus } from "@prisma/client";

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

test("post-delete diagnosis recovers SUCCESS only when every DELETE was accepted and every planned URI is gone", () => {
  const planned = ["spotify:track:a", "spotify:track:b"];

  assert.equal(
    classifyPostDeleteDiagnosis(planned, planned, planned, []),
    MusicSourceCleanupStatus.SUCCESS,
  );
  assert.equal(
    classifyPostDeleteDiagnosis(
      planned,
      ["spotify:track:a"],
      planned,
      [],
    ),
    MusicSourceCleanupStatus.PARTIAL,
  );
  assert.equal(
    classifyPostDeleteDiagnosis(
      planned,
      planned,
      ["spotify:track:a"],
      ["spotify:track:b"],
    ),
    MusicSourceCleanupStatus.PARTIAL,
  );
  assert.equal(
    classifyPostDeleteDiagnosis(planned, [], [], planned),
    MusicSourceCleanupStatus.FAILED,
  );
});

test("recovered SUCCESS persists first cleanup and returns success instead of rethrowing verification drift", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const catchStart = source.indexOf("} catch (error) {");
  const catchBody = source.slice(catchStart);

  assert.match(catchBody, /classifyPostDeleteDiagnosis/);
  assert.match(catchBody, /musicCleanupFirstCompletedAt: finishedAt/);
  assert.match(catchBody, /status === MusicSourceCleanupStatus\.SUCCESS/);
  assert.match(catchBody, /return \{/);
  assert.match(source, /acceptedDeleteUris\.push\(\.\.\.uris\)/);
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


test("cached cleanup planning stays conservative and accounts for duplicate occurrences", () => {
  const plan = buildCachedMusicSourceCleanupPlan(
    [
      { uri: "spotify:track:a", spotifyTrackId: "a" },
      { uri: "spotify:track:a", spotifyTrackId: "a" },
      { uri: "spotify:track:b", spotifyTrackId: "b" },
    ],
    new Set(["a"]),
  );
  assert.deepEqual(plan.removableUris, ["spotify:track:a"]);
  assert.equal(plan.removalOccurrenceCount, 2);
  assert.equal(plan.keptCount, 1);
});

test("periodic cleanup is cache-backed and never performs a full playlist-items scan", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const start = source.indexOf("export async function executeAutomaticMusicSourceCleanup");
  const end = source.indexOf("\nasync function loadManagedMusicSource", start);
  assert.ok(start >= 0 && end > start);
  const automatic = source.slice(start, end);

  assert.match(automatic, /decodeMusicSourceCache/);
  assert.match(automatic, /readPlaylistMetadata/);
  assert.match(automatic, /snapshot_id: snapshotAfter/);
  assert.match(automatic, /patchMusicSourceCacheAfterRemove/);
  assert.doesNotMatch(automatic, /readStablePlaylist\(/);
  assert.doesNotMatch(automatic, /createMusicSourceCleanupPreview\(/);
});

test("manual cleanup preserves cache continuity when the pre-write snapshot was proven", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  assert.match(source, /preview\.source\.spotifySnapshotId === current\.snapshotId/);
  assert.match(source, /patchMusicSourceCacheAfterRemove/);
});


test("ambiguous automatic DELETE failure invalidates cache instead of trusting the last known snapshot", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const start = source.indexOf("export async function executeAutomaticMusicSourceCleanup");
  const end = source.indexOf("\nasync function loadManagedMusicSource", start);
  assert.ok(start >= 0 && end > start);
  const automatic = source.slice(start, end);
  assert.match(automatic, /const patchedCache = writeError\s*\? null/);
  assert.match(automatic, /writeError[\s\S]*spotifySnapshotId: null/);
});


test("periodic cleanup rejects missing cache before Spotify history traffic", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const start = source.indexOf("export async function executeAutomaticMusicSourceCleanup");
  const end = source.indexOf("\nasync function loadManagedMusicSource", start);
  assert.ok(start >= 0 && end > start);
  const automatic = source.slice(start, end);
  assert.ok(automatic.indexOf("decodeMusicSourceCache") < automatic.indexOf("syncRecentlyPlayed"));
  assert.ok(automatic.indexOf("readPlaylistMetadata") < automatic.indexOf("syncRecentlyPlayed"));
});
