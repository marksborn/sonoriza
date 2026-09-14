import assert from "node:assert/strict";
import test from "node:test";

import { mergeBlockedMusicTrackIdsByTargetId } from "./incremental-planning";

test("MUSIC-07 blocks are unioned with MUSIC-05 only within the same target", () => {
  const music05 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["m05-carro", "shared"])],
    ["trabalho", new Set(["m05-trabalho"])],
  ]);
  const music07 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["m07-carro", "shared"])],
    ["avulsa", new Set(["m07-avulsa"])],
  ]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(music05, music07);

  assert.deepEqual([...merged.get("carro")!].sort(), [
    "m05-carro",
    "m07-carro",
    "shared",
  ]);
  assert.deepEqual([...merged.get("trabalho")!], ["m05-trabalho"]);
  assert.deepEqual([...merged.get("avulsa")!], ["m07-avulsa"]);
});

test("same track blocked on one target does not contaminate another target", () => {
  const music07 = new Map<string, ReadonlySet<string>>([
    ["carro", new Set(["track-x"])],
    ["avulsa", new Set(["track-y"])],
  ]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(undefined, music07);

  assert.equal(merged.get("carro")?.has("track-x"), true);
  assert.equal(merged.get("carro")?.has("track-y"), false);
  assert.equal(merged.get("avulsa")?.has("track-y"), true);
  assert.equal(merged.get("avulsa")?.has("track-x"), false);
});

test("empty maps remain empty and input sets are not mutated", () => {
  const baseSet = new Set(["a"]);
  const music07Set = new Set(["b"]);
  const base = new Map<string, ReadonlySet<string>>([["carro", baseSet]]);
  const music07 = new Map<string, ReadonlySet<string>>([["carro", music07Set]]);

  const merged = mergeBlockedMusicTrackIdsByTargetId(base, music07);
  (merged.get("carro") as Set<string>).add("c");

  assert.deepEqual([...baseSet], ["a"]);
  assert.deepEqual([...music07Set], ["b"]);
  assert.equal(mergeBlockedMusicTrackIdsByTargetId(undefined, undefined).size, 0);
});
