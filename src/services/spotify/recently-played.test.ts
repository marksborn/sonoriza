import assert from "node:assert/strict";
import test from "node:test";
import { MusicRepeatWindowUnit } from "@prisma/client";

import type { Candidate } from "@/services/playlist-planner";

import {
  computeMusicRepeatCutoff,
  filterMusicCandidatesForRepeat,
  scopeIncludes,
  spotifyTrackIdentityAliases,
  type MusicRepeatContext,
} from "./recently-played";

function context(blocked: string[] = []): MusicRepeatContext {
  return {
    enabled: true,
    windowValue: 30,
    windowUnit: MusicRepeatWindowUnit.DAYS,
    cutoff: new Date("2026-07-09T12:00:00.000Z"),
    historyKnownSince: new Date("2026-07-01T00:00:00.000Z"),
    lastSyncAt: new Date("2026-08-08T12:00:00.000Z"),
    blockedTrackIds: new Set(blocked),
  };
}

const music = (id?: string): Candidate => ({
  uri: `spotify:track:${id ?? "missing"}`,
  ...(id ? { spotifyTrackId: id } : {}),
  type: "MUSIC",
  title: id ?? "missing",
  durationMs: 180_000,
});

test("DAYS subtracts calendar days while preserving UTC clock time", () => {
  const now = new Date("2026-08-08T17:30:45.123Z");
  assert.equal(
    computeMusicRepeatCutoff(now, 30, MusicRepeatWindowUnit.DAYS).toISOString(),
    "2026-07-09T17:30:45.123Z",
  );
});

test("MONTHS uses calendar semantics and clamps month end", () => {
  const now = new Date("2026-03-31T08:15:00.000Z");
  assert.equal(
    computeMusicRepeatCutoff(now, 1, MusicRepeatWindowUnit.MONTHS).toISOString(),
    "2026-02-28T08:15:00.000Z",
  );
});

test("YEARS clamps leap day without converting years to days", () => {
  const now = new Date("2028-02-29T08:15:00.000Z");
  assert.equal(
    computeMusicRepeatCutoff(now, 1, MusicRepeatWindowUnit.YEARS).toISOString(),
    "2027-02-28T08:15:00.000Z",
  );
});

test("recently played music is excluded before the planner", () => {
  const result = filterMusicCandidatesForRepeat(
    [music("recent"), music("eligible")],
    context(["recent"]),
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.spotifyTrackId), ["eligible"]);
  assert.equal(result.recentlyPlayedSkippedCount, 1);
  assert.equal(result.missingTrackIdentitySkippedCount, 0);
});

test("enabled cooldown rejects missing music identity instead of bypassing history", () => {
  const result = filterMusicCandidatesForRepeat([music()], context());
  assert.equal(result.candidates.length, 0);
  assert.equal(result.missingTrackIdentitySkippedCount, 1);
});

test("disabled cooldown leaves all candidates untouched", () => {
  const disabled: MusicRepeatContext = {
    ...context(["recent"]),
    enabled: false,
    blockedTrackIds: new Set(["recent"]),
  };
  const input = [music("recent"), music()];
  const result = filterMusicCandidatesForRepeat(input, disabled);
  assert.equal(result.candidates, input);
  assert.equal(result.recentlyPlayedSkippedCount, 0);
  assert.equal(result.missingTrackIdentitySkippedCount, 0);
});

test("Track Relinking records original and effective Spotify identities as aliases", () => {
  assert.deepEqual(
    spotifyTrackIdentityAliases({
      id: "replacement",
      uri: "spotify:track:replacement",
      linked_from: { id: "original" },
    }).sort(),
    ["original", "replacement"],
  );
});

test("scope matching is exact and does not accept partial scope names", () => {
  assert.equal(scopeIncludes("user-read-email user-read-recently-played", "user-read-recently-played"), true);
  assert.equal(scopeIncludes("user-read-email user-read-recently", "user-read-recently-played"), false);
});
