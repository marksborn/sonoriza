import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("MUSIC-02 quota fallback stays dry-run and anchored to an audited snapshot", () => {
  const route = readFileSync(
    "src/app/api/music-source-cleanup/preview/route.ts",
    "utf8",
  );

  assert.match(route, /kind[^\n]+QUOTA_EXCEEDED/);
  assert.match(route, /decodeMusicSourceCache/);
  assert.match(route, /snapshotBefore:\s*source\.spotifySnapshotId/);
  assert.match(route, /snapshotBefore:\s*source\.spotifySnapshotId[\s\S]*examinedCount:\s*\{ gt: 0 \}/);
  assert.match(route, /status:\s*MusicSourceCleanupStatus\.PREVIEW/);
  assert.match(route, /plannedUris:\s*cachedPlan\.removableUris/);

  assert.doesNotMatch(route, /executeMusicSourceCleanupPreview/);
  assert.doesNotMatch(route, /method:\s*["']DELETE["']/);
  assert.doesNotMatch(route, /musicCleanupFirstCompletedAt\s*:/);
  assert.doesNotMatch(route, /musicCleanupAutomationEnabled\s*:/);
});
