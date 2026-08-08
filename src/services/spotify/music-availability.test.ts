import assert from "node:assert/strict";
import test from "node:test";
import { readPlayableMusicCandidate } from "./music-availability";
const base = { uri: "spotify:track:ok", name: "Playable", duration_ms: 180_000, type: "track", is_local: false, artists: [{ name: "Artist" }] };
test("normal playable track becomes a music candidate", () => {
  const result = readPlayableMusicCandidate({ ...base, is_playable: true });
  assert.equal(result.unavailable, false); assert.equal(result.candidate?.uri, base.uri);
});
test("is_playable=false is explicitly unavailable", () => {
  const result = readPlayableMusicCandidate({ ...base, is_playable: false });
  assert.equal(result.candidate, null); assert.equal(result.unavailable, true);
});
test("any Spotify restriction excludes the track, including future reasons", () => {
  const result = readPlayableMusicCandidate({ ...base, is_playable: true, restrictions: { reason: "future-policy" } });
  assert.equal(result.candidate, null); assert.equal(result.unavailable, true); assert.equal(result.restrictionReason, "future-policy");
});
test("local track stays excluded without being counted as provider unavailability", () => {
  const result = readPlayableMusicCandidate({ ...base, is_local: true });
  assert.equal(result.candidate, null); assert.equal(result.unavailable, false);
});
test("missing is_playable without a restriction does not invent unavailability", () => {
  const result = readPlayableMusicCandidate(base); assert.equal(result.unavailable, false); assert.equal(result.candidate?.uri, base.uri);
});
