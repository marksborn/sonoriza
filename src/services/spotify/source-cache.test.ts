import assert from "node:assert/strict";
import test from "node:test";

import type { Candidate } from "@/services/playlist-planner";
import { decodeMusicSourceCache, encodeMusicSourceCache } from "./source-cache";

const candidates: Candidate[] = [
  {
    uri: "spotify:track:one",
    type: "MUSIC",
    title: "One",
    subtitle: "Artist",
    durationMs: 180_000,
  },
  {
    uri: "spotify:track:two",
    type: "MUSIC",
    title: "Two",
    durationMs: 200_000,
  },
];

test("music cache round-trips only planner-safe static fields", () => {
  assert.deepEqual(decodeMusicSourceCache(encodeMusicSourceCache(candidates)), candidates);
});

test("music cache rejects unknown versions and malformed candidates", () => {
  assert.equal(
    decodeMusicSourceCache({ version: 2, candidates: [] }),
    null,
  );
  assert.equal(
    decodeMusicSourceCache({
      version: 1,
      candidates: [{ uri: "spotify:track:x", title: "X", durationMs: "bad" }],
    }),
    null,
  );
});
