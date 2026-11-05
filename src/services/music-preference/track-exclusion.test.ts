import assert from "node:assert/strict";
import test from "node:test";

import { applyFirstPartyPlaybackPreferencesToMusicCandidates } from "./first-party-planner-preferences";
import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import type { FirstPartyPlaybackPreferenceStore } from "./first-party-playback-preference-store";
import {
  excludeTrackForUser,
  excludedSpotifyTrackIds,
  isSpotifyTrackId,
  loadExcludedSpotifyTrackIds,
  restoreTrackForUser,
} from "./track-exclusion";

const TRACK = "0OdUWJ0sBjDrqHygGUXeCF";
const OTHER = "3TVXtAsR1Inumwj472S9r4";

function memoryStore(): FirstPartyPlaybackPreferenceStore & { rows: FirstPartyPlaybackPreference[] } {
  const rows: FirstPartyPlaybackPreference[] = [];
  return {
    rows,
    async set(input) {
      const at = rows.findIndex(
        (row) => row.subjectType === input.subjectType && row.subjectKey === input.subjectKey,
      );
      const row = { ...input, id: "p", createdAt: new Date(0), updatedAt: new Date(0) };
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      return row;
    },
    async list(_userId, subjectType) {
      return rows.filter((row) => !subjectType || row.subjectType === subjectType);
    },
    async remove(_userId, subjectType, subjectKey) {
      const at = rows.findIndex(
        (row) => row.subjectType === subjectType && row.subjectKey === subjectKey,
      );
      if (at < 0) return false;
      rows.splice(at, 1);
      return true;
    },
  };
}

test("exclude is explicit, first-party and reversible", async () => {
  const store = memoryStore();
  await excludeTrackForUser("u", TRACK, store);
  assert.equal(store.rows[0]!.source, "USER_EXPLICIT");
  assert.equal(store.rows[0]!.policy, "EXCLUDED");
  assert.deepEqual([...(await loadExcludedSpotifyTrackIds("u", store))], [TRACK]);
  assert.equal(await restoreTrackForUser("u", TRACK, store), true);
  assert.equal((await loadExcludedSpotifyTrackIds("u", store)).size, 0);
});

test("restore never removes a different preference on the same track", async () => {
  const store = memoryStore();
  await store.set({
    userId: "u",
    subjectType: "TRACK",
    subjectKey: `spotify:track:${TRACK}`,
    policy: "PREFERRED",
    source: "USER_EXPLICIT",
  });
  assert.equal(await restoreTrackForUser("u", TRACK, store), false);
  assert.equal(store.rows.length, 1);
});

test("invalid ids are rejected before any write", async () => {
  const store = memoryStore();
  assert.equal(isSpotifyTrackId("spotify:track:x"), false);
  assert.equal(isSpotifyTrackId(null), false);
  await assert.rejects(() => excludeTrackForUser("u", "not-an-id", store));
  assert.equal(store.rows.length, 0);
});

test("only TRACK + EXCLUDED rows count", () => {
  const base = { id: "p", userId: "u", source: "USER_EXPLICIT" as const, createdAt: new Date(0), updatedAt: new Date(0) };
  const ids = excludedSpotifyTrackIds([
    { ...base, subjectType: "TRACK", subjectKey: `spotify:track:${TRACK}`, policy: "EXCLUDED" },
    { ...base, subjectType: "TRACK", subjectKey: `spotify:track:${OTHER}`, policy: "PREFERRED" },
    { ...base, subjectType: "ARTIST", subjectKey: "spotify:artist:a", policy: "EXCLUDED" },
  ]);
  assert.deepEqual([...ids], [TRACK]);
});

test("the planner filter removes exactly that recording under the real data policy", async () => {
  const store = memoryStore();
  await excludeTrackForUser("u", TRACK, store);
  const candidate = (spotifyTrackId: string) => ({
    uri: `spotify:track:${spotifyTrackId}`,
    type: "MUSIC" as const,
    title: "Same song",
    spotifyTrackId,
    durationMs: 1000,
  });
  const { candidates, evidence } = applyFirstPartyPlaybackPreferencesToMusicCandidates(
    [candidate(TRACK), candidate(OTHER)],
    store.rows,
  );
  assert.deepEqual(candidates.map((row) => row.spotifyTrackId), [OTHER]);
  assert.equal(evidence.capabilityBlockedPreferenceCount, 0);
  assert.equal(evidence.excludedCandidateCount, 1);
});
