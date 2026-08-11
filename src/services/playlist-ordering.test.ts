import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMusicOrder,
  createMusicOrderSeed,
  readMusicOrderEvidenceFromSummary,
  type OrderablePlaylistItem,
} from "./playlist-ordering";

function fixture(): OrderablePlaylistItem[] {
  return [
    { position: 0, type: "MUSIC", uri: "spotify:track:A" },
    { position: 1, type: "MUSIC", uri: "spotify:track:B" },
    { position: 2, type: "PODCAST", uri: "spotify:episode:P1" },
    { position: 3, type: "MUSIC", uri: "spotify:track:C" },
    { position: 4, type: "MUSIC", uri: "spotify:track:D" },
    { position: 5, type: "PODCAST", uri: "spotify:episode:P2" },
    { position: 6, type: "MUSIC", uri: "spotify:track:E" },
  ];
}

function uris(items: OrderablePlaylistItem[]) {
  return items.map((item) => item.uri);
}

test("STANDARD preserves the exact planned order", () => {
  const input = fixture();
  const ordered = applyMusicOrder(input, "STANDARD", null);
  assert.deepEqual(uris(ordered.items), uris(input));
  assert.equal(ordered.evidence.seed, null);
  assert.equal(ordered.evidence.changed, false);
});

test("RANDOMIZED is deterministic for the same seed", () => {
  const first = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  const second = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  assert.deepEqual(uris(first.items), uris(second.items));
  assert.equal(first.evidence.orderHash, second.evidence.orderHash);
});

test("RANDOMIZED changes only music identities, preserving podcast slots and selected set", () => {
  const input = fixture();
  const ordered = applyMusicOrder(input, "RANDOMIZED", "seed-a");

  assert.deepEqual(
    ordered.items.map((item) => item.type),
    input.map((item) => item.type),
  );
  assert.equal(ordered.items[2]?.uri, "spotify:episode:P1");
  assert.equal(ordered.items[5]?.uri, "spotify:episode:P2");
  assert.deepEqual([...uris(ordered.items)].sort(), [...uris(input)].sort());
  assert.deepEqual(
    ordered.items.map((item) => item.position),
    input.map((item) => item.position),
  );
  assert.equal(ordered.evidence.changed, true);
});

test("different seeds can produce different music order", () => {
  const first = applyMusicOrder(fixture(), "RANDOMIZED", "seed-a");
  const second = applyMusicOrder(fixture(), "RANDOMIZED", "seed-b");
  assert.notDeepEqual(uris(first.items), uris(second.items));
});

test("execution seed is stable for one run/target and changes with the run", () => {
  assert.equal(
    createMusicOrderSeed("run-a", "target-1"),
    createMusicOrderSeed("run-a", "target-1"),
  );
  assert.notEqual(
    createMusicOrderSeed("run-a", "target-1"),
    createMusicOrderSeed("run-b", "target-1"),
  );
});

test("reads only complete RANDOMIZED seed/hash evidence from persisted run summary", () => {
  assert.deepEqual(
    readMusicOrderEvidenceFromSummary({
      targets: [
        {
          targetPlaylistId: "car",
          musicOrderMode: "RANDOMIZED",
          musicOrderSeed: "seed-car",
          musicOrderHash: "hash-car",
        },
        {
          targetPlaylistId: "work",
          musicOrderMode: "STANDARD",
          musicOrderSeed: "ignored",
          musicOrderHash: "ignored",
        },
        {
          targetPlaylistId: "missing-hash",
          musicOrderMode: "RANDOMIZED",
          musicOrderSeed: "seed-only",
        },
      ],
    }),
    { car: { seed: "seed-car", orderHash: "hash-car" } },
  );
});
