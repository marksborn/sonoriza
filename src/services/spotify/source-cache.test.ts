import assert from "node:assert/strict";
import test from "node:test";
import type { Candidate } from "@/services/playlist-planner";
import {
  decodeMusicSourceCache,
  decodeMusicSourceCacheUnavailableTrackCount,
  encodeMusicSourceCache,
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
