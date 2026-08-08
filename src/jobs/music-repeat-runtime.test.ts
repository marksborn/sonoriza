import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MusicRepeatWindowUnit } from "@prisma/client";

import type { Candidate, RunTarget } from "@/services/playlist-planner";

import {
  collectIncrementally,
  type IncrementalCandidateSource,
  type IncrementalSourceBatch,
  type IncrementalSourceKind,
} from "./incremental-planning";
import { runWithMusicRepeatState, type MusicRepeatRunState } from "./music-repeat-runtime";

function candidate(id: string, kind: IncrementalSourceKind, durationMs: number): Candidate {
  return {
    uri: kind === "MUSIC" ? `spotify:track:${id}` : `spotify:episode:${id}`,
    type: kind,
    title: id,
    durationMs,
    ...(kind === "MUSIC" ? { spotifyTrackId: id } : { programId: id }),
  };
}

function source(
  id: string,
  kind: IncrementalSourceKind,
  batches: IncrementalSourceBatch[],
): IncrementalCandidateSource & { calls: number } {
  let calls = 0;
  let done = false;
  return {
    id,
    label: id,
    kind,
    get calls() {
      return calls;
    },
    get done() {
      return done;
    },
    async readNext() {
      const batch = batches[calls++];
      if (!batch) throw new Error(`Unexpected read ${calls}`);
      done = batch.done;
      return batch;
    },
  };
}

function target(): RunTarget {
  return {
    targetPlaylistId: "target",
    name: "Target",
    priority: 0,
    rules: {
      targetDurationMs: 600_000,
      compositionMode: "SEQUENCE",
      podcastPercent: 50,
      sequencePattern: ["MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 10,
    },
  };
}

function state(blocked: string[]): MusicRepeatRunState {
  return {
    userId: "test-user",
    simulate: true,
    context: {
      enabled: true,
      windowValue: 30,
      windowUnit: MusicRepeatWindowUnit.DAYS,
      cutoff: new Date("2026-07-09T00:00:00.000Z"),
      historyKnownSince: new Date("2026-07-01T00:00:00.000Z"),
      lastSyncAt: new Date("2026-08-08T00:00:00.000Z"),
      blockedTrackIds: new Set(blocked),
    },
    initialSync: {
      enabled: true,
      eventsRead: 1,
      identitiesUpdated: 1,
      historyKnownSince: new Date("2026-07-01T00:00:00.000Z"),
      lastSyncAt: new Date("2026-08-08T00:00:00.000Z"),
    },
    recentlyPlayedSkippedCount: 0,
    missingTrackIdentitySkippedCount: 0,
    preWriteSync: null,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    preWriteMissingIdentityCount: 0,
  };
}

test("recent track is removed before planner and later eligible music can fill the sequence", async () => {
  const music = source("music", "MUSIC", [
    { candidates: [candidate("recent", "MUSIC", 300_000)], done: false },
    { candidates: [candidate("eligible", "MUSIC", 300_000)], done: true },
  ]);
  const podcast = source("podcast", "PODCAST", [
    { candidates: [candidate("episode", "PODCAST", 300_000)], done: true },
  ]);
  const runtime = state(["recent"]);

  const result = await runWithMusicRepeatState(runtime, () =>
    collectIncrementally({ sources: [music, podcast], targets: [target()] }),
  );

  assert.equal(result.qualityFailures.length, 0);
  assert.equal(music.calls, 2);
  assert.deepEqual(result.pools.music.map((item) => item.spotifyTrackId), ["eligible"]);
  assert.equal(runtime.recentlyPlayedSkippedCount, 1);
});

test("blocked music from another source cannot re-enter the shared pool", async () => {
  const duplicate = candidate("recent", "MUSIC", 300_000);
  const musicA = source("music-a", "MUSIC", [{ candidates: [duplicate], done: true }]);
  const musicB = source("music-b", "MUSIC", [{ candidates: [duplicate], done: true }]);
  const podcast = source("podcast", "PODCAST", [
    { candidates: [candidate("episode", "PODCAST", 300_000)], done: true },
  ]);
  const runtime = state(["recent"]);

  const result = await runWithMusicRepeatState(runtime, () =>
    collectIncrementally({ sources: [musicA, musicB, podcast], targets: [target()] }),
  );

  assert.equal(result.pools.music.length, 0);
  assert.equal(result.qualityFailures.length, 1);
  assert.equal(runtime.recentlyPlayedSkippedCount, 2);
});

test("real-run revalidation is positioned before Spotify writer creation", () => {
  const collector = readFileSync("src/jobs/incremental-planning.ts", "utf8");
  const generator = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");

  assert.match(collector, /await revalidateMusicRepeatBeforeRealWrite\(plan\)/);
  const collectCall = generator.indexOf("await collectIncrementally({");
  const writerCreation = generator.indexOf("if (!simulate) writer = await SpotifyClient.forUser(userId)");
  assert.ok(collectCall >= 0 && writerCreation > collectCall);
});
