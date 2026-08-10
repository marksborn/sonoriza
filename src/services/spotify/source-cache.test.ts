import assert from "node:assert/strict";
import test from "node:test";
import type { Candidate } from "@/services/playlist-planner";
import {
  decodeMusicSourceCache,
  decodeMusicSourceCacheUnavailableTrackCount,
  decodePartialMusicSourceCache,
  encodeMusicSourceCache,
  encodePartialMusicSourceCache,
  patchMusicSourceCacheAfterAppend,
  patchMusicSourceCacheAfterRemove,
} from "./source-cache";

const candidates: Candidate[] = [
  {
    uri: "spotify:track:one",
    spotifyTrackId: "one",
    type: "MUSIC",
    title: "One",
    subtitle: "Artist",
    durationMs: 180_000,
  },
  {
    uri: "spotify:track:two",
    spotifyTrackId: "two",
    type: "MUSIC",
    title: "Two",
    durationMs: 200_000,
  },
];

test("music cache v3 round-trips canonical track identity and availability count", () => {
  const encoded = encodeMusicSourceCache(candidates, 3);
  assert.deepEqual(decodeMusicSourceCache(encoded), candidates);
  assert.equal(decodeMusicSourceCacheUnavailableTrackCount(encoded), 3);
});

test("music cache rejects versions without canonical track identity and malformed payloads", () => {
  assert.equal(decodeMusicSourceCache({ version: 1, candidates: [] }), null);
  assert.equal(
    decodeMusicSourceCache({ version: 2, unavailableTrackCount: 0, candidates: [] }),
    null,
  );
  assert.equal(
    decodeMusicSourceCache({ version: 3, unavailableTrackCount: -1, candidates: [] }),
    null,
  );
  assert.equal(
    decodeMusicSourceCache({
      version: 3,
      unavailableTrackCount: 0,
      candidates: [{ uri: "spotify:track:x", title: "X", durationMs: 123 }],
    }),
    null,
  );
});

test("encoder omits music candidates whose Spotify identity is missing", () => {
  const encoded = encodeMusicSourceCache([
    ...candidates,
    { uri: "spotify:track:legacy", type: "MUSIC", title: "Legacy", durationMs: 1 },
  ]);
  assert.equal(encoded.candidates.length, 2);
});


test("append patch advances a valid cache without discarding the existing pool", () => {
  const encoded = encodeMusicSourceCache(candidates, 3);
  const appended: Candidate = {
    uri: "spotify:track:three",
    spotifyTrackId: "three",
    type: "MUSIC",
    title: "Three",
    subtitle: "Artist",
    durationMs: 210_000,
  };
  const patched = patchMusicSourceCacheAfterAppend(encoded, [appended]);
  assert.ok(patched);
  assert.deepEqual(decodeMusicSourceCache(patched), [...candidates, appended]);
  assert.equal(decodeMusicSourceCacheUnavailableTrackCount(patched), 3);
});

test("remove patch removes every cached occurrence of an accepted URI", () => {
  const duplicateCandidates: Candidate[] = [candidates[0]!, candidates[0]!, candidates[1]!];
  const encoded = encodeMusicSourceCache(duplicateCandidates, 2);
  const patched = patchMusicSourceCacheAfterRemove(encoded, ["spotify:track:one"]);
  assert.ok(patched);
  assert.deepEqual(decodeMusicSourceCache(patched), [candidates[1]]);
  assert.equal(decodeMusicSourceCacheUnavailableTrackCount(patched), 2);
});

test("remove patch fails closed when the removed URI is absent from the planner cache", () => {
  const encoded = encodeMusicSourceCache(candidates, 1);
  assert.equal(
    patchMusicSourceCacheAfterRemove(encoded, ["spotify:track:not-cached"]),
    null,
  );
});


test("partial cache checkpoints are resumable but never decode as a complete cache", () => {
  const partial = encodePartialMusicSourceCache(candidates, 4, 100);
  assert.equal(decodeMusicSourceCache(partial), null);
  assert.deepEqual(decodePartialMusicSourceCache(partial), {
    candidates,
    unavailableTrackCount: 4,
    nextOffset: 100,
  });
});

test("partial cache may checkpoint all item pages while waiting for final snapshot validation", () => {
  const partial = encodePartialMusicSourceCache(candidates, 1, null);
  const decoded = decodePartialMusicSourceCache(partial);
  assert.ok(decoded);
  assert.equal(decoded.nextOffset, null);
  assert.equal(decodeMusicSourceCache(partial), null);
});
