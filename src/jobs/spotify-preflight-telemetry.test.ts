import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyRequestMetrics } from "@/services/spotify/errors";
import {
  addScheduledSpotifyPreflight,
  preserveScheduledSpotifyPreflight,
  summarizeScheduledSpotifyPreflight,
} from "./spotify-preflight-telemetry";

function metrics(input: {
  totalCalls: number;
  criticalGet5xxRetries: number;
  criticalGet5xxRecoveries: number;
  retryWaitMs: number;
  callsByOperation: Record<string, number>;
}): SpotifyRequestMetrics {
  return {
    ...input,
    retries: input.criticalGet5xxRetries,
    rateLimitedCount: 0,
    quotaExceededCount: 0,
    circuitOpenSkips: 0,
    cacheHits: 0,
    cacheMisses: 0,
    memoizedReadHits: 0,
    sourceReads: { "PLAYLIST:secret-id": {
      pagesRead: 1, cacheHits: 0, cacheMisses: 0,
      snapshotUnchanged: 0, snapshotChanged: 0, memoizedHits: 0,
      cacheWrites: 0, cacheWriteFailures: 0,
    } },
  };
}

test("#521 records retry recovery for KEEP_FILLED without Spotify identifiers", () => {
  const after = metrics({
    totalCalls: 5,
    criticalGet5xxRetries: 2,
    criticalGet5xxRecoveries: 1,
    retryWaitMs: 3_000,
    callsByOperation: { "episode-state": 3, "playlist-metadata": 2, "PLAYLIST:secret-id": 9 },
  });
  const summary = summarizeScheduledSpotifyPreflight({
    phase: "KEEP_FILLED", startedAtMs: 100, endedAtMs: 3_400, after,
  });
  assert.equal(summary.elapsedMs, 3_300);
  assert.equal(summary.totalCalls, 5);
  assert.equal(summary.criticalGet5xxRetries, 2);
  assert.equal(summary.criticalGet5xxRecoveries, 1);
  assert.deepEqual(summary.callsByOperation, { "playlist-metadata": 2, "episode-state": 3 });
  assert.doesNotMatch(JSON.stringify(summary), /secret-id|spotify:episode|Bearer/);
});

test("#521 reused REBUILD client records only the current slot delta", () => {
  const before = metrics({
    totalCalls: 3, criticalGet5xxRetries: 1, criticalGet5xxRecoveries: 1,
    retryWaitMs: 1_000, callsByOperation: { "playlist-metadata": 2, "episode-state": 1 },
  });
  const after = metrics({
    totalCalls: 7, criticalGet5xxRetries: 3, criticalGet5xxRecoveries: 2,
    retryWaitMs: 4_000, callsByOperation: { "playlist-metadata": 4, "episode-state": 3 },
  });
  const summary = summarizeScheduledSpotifyPreflight({
    phase: "REBUILD", startedAtMs: 0, endedAtMs: 4_500, before, after,
  });
  assert.equal(summary.totalCalls, 4);
  assert.equal(summary.criticalGet5xxRetries, 2);
  assert.equal(summary.criticalGet5xxRecoveries, 1);
  assert.equal(summary.retryWaitMs, 3_000);
  assert.deepEqual(summary.callsByOperation, { "playlist-metadata": 2, "episode-state": 2 });
});

test("#521 telemetry survives checkpoint, generation link and final details", () => {
  const summary = summarizeScheduledSpotifyPreflight({
    phase: "KEEP_FILLED", startedAtMs: 20, endedAtMs: 50,
  });
  const afterPreflight = addScheduledSpotifyPreflight({ checkpoint: "KEEP_FILLED_PREP_DONE" }, summary);
  const afterLink = preserveScheduledSpotifyPreflight(afterPreflight, {
    checkpoint: "GENERATION_LINKED", generationRunId: "internal-generation",
  });
  const afterFinish = preserveScheduledSpotifyPreflight(afterLink, { preservedCount: 4 });
  assert.equal(afterLink.checkpoint, "GENERATION_LINKED");
  assert.deepEqual(afterFinish.spotifyPreflight, summary);
  assert.equal(afterFinish.preservedCount, 4);
  assert.deepEqual(preserveScheduledSpotifyPreflight({}, { checkpoint: "CLAIMED" }), {
    checkpoint: "CLAIMED",
  });
});
