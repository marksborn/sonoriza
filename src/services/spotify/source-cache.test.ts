import assert from "node:assert/strict";
import test from "node:test";
import type { Candidate } from "@/services/playlist-planner";
import { decodeMusicSourceCache, decodeMusicSourceCacheUnavailableTrackCount, encodeMusicSourceCache } from "./source-cache";
const candidates: Candidate[] = [
  { uri: "spotify:track:one", type: "MUSIC", title: "One", subtitle: "Artist", durationMs: 180_000 },
  { uri: "spotify:track:two", type: "MUSIC", title: "Two", durationMs: 200_000 },
];
test("music cache v2 round-trips planner-safe fields and availability count", () => {
  const encoded = encodeMusicSourceCache(candidates, 3);
  assert.deepEqual(decodeMusicSourceCache(encoded), candidates);
  assert.equal(decodeMusicSourceCacheUnavailableTrackCount(encoded), 3);
});
test("music cache rejects pre-availability versions and malformed payloads", () => {
  assert.equal(decodeMusicSourceCache({ version: 1, candidates: [] }), null);
  assert.equal(decodeMusicSourceCache({ version: 2, unavailableTrackCount: -1, candidates: [] }), null);
  assert.equal(decodeMusicSourceCache({ version: 2, unavailableTrackCount: 0, candidates: [{ uri: "spotify:track:x", title: "X", durationMs: "bad" }] }), null);
});
