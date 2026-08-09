import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAuditedCacheFallbackPlan } from "./source-cleanup-audited-fallback";

test("MUSIC-02 fallback preserves audited omitted tracks and adds newly played cached duplicates", () => {
  const plan = buildAuditedCacheFallbackPlan({
    baseline: {
      examinedCount: 4,
      removalOccurrenceCount: 1,
      plannedUris: ["spotify:track:unavailable"],
    },
    cachedCandidates: [
      { uri: "spotify:track:new", spotifyTrackId: "new" },
      { uri: "spotify:track:new", spotifyTrackId: "new" },
      { uri: "spotify:track:other", spotifyTrackId: "other" },
    ],
    playedTrackIds: new Set(["new"]),
    changedPlayedTracks: [
      { spotifyTrackId: "new", spotifyUri: "spotify:track:new" },
    ],
  });

  assert.ok(plan);
  assert.deepEqual(plan.removableUris, [
    "spotify:track:new",
    "spotify:track:unavailable",
  ]);
  assert.equal(plan.removableTrackCount, 2);
  assert.equal(plan.removalOccurrenceCount, 3);
  assert.equal(plan.keptCount, 1);
});

test("MUSIC-02 fallback fails closed when a changed playback cannot be classified by cache or baseline", () => {
  const plan = buildAuditedCacheFallbackPlan({
    baseline: {
      examinedCount: 3,
      removalOccurrenceCount: 0,
      plannedUris: [],
    },
    cachedCandidates: [
      { uri: "spotify:track:known", spotifyTrackId: "known" },
    ],
    playedTrackIds: new Set(["unknown"]),
    changedPlayedTracks: [
      { spotifyTrackId: "unknown", spotifyUri: "spotify:track:unknown" },
    ],
  });

  assert.equal(plan, null);
});

test("MUSIC-02 fallback accepts a changed playback already covered by the audited baseline", () => {
  const plan = buildAuditedCacheFallbackPlan({
    baseline: {
      examinedCount: 2,
      removalOccurrenceCount: 1,
      plannedUris: ["spotify:track:omitted"],
    },
    cachedCandidates: [
      { uri: "spotify:track:other", spotifyTrackId: "other" },
    ],
    playedTrackIds: new Set(["omitted"]),
    changedPlayedTracks: [
      { spotifyTrackId: "omitted", spotifyUri: "spotify:track:omitted" },
    ],
  });

  assert.ok(plan);
  assert.deepEqual(plan.removableUris, ["spotify:track:omitted"]);
  assert.equal(plan.removalOccurrenceCount, 1);
});

test("MUSIC-02 quota fallback is limited to playlist-items and stays dry-run", () => {
  const route = readFileSync(
    "src/app/api/music-source-cleanup/preview/route.ts",
    "utf8",
  );

  assert.match(route, /kind[^\n]+QUOTA_EXCEEDED/);
  assert.match(route, /operation[^\n]+playlist-items/);
  assert.match(route, /buildAuditedCacheFallbackPlan/);
  assert.match(route, /status:\s*MusicSourceCleanupStatus\.PREVIEW/);
  assert.match(route, /snapshotBefore:\s*source\.spotifySnapshotId/);

  assert.doesNotMatch(route, /executeMusicSourceCleanupPreview/);
  assert.doesNotMatch(route, /method:\s*["']DELETE["']/);
  assert.doesNotMatch(route, /musicCleanupFirstCompletedAt\s*:/);
  assert.doesNotMatch(route, /musicCleanupAutomationEnabled\s*:/);
});
