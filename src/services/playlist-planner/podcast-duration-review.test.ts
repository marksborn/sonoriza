import assert from "node:assert/strict";
import test from "node:test";

import { readPodcast08TargetReviews } from "./podcast-duration-review";

test("applied bands report fallbacks; abstentions explain why", () => {
  const reviews = readPodcast08TargetReviews({
    podcast08ActiveGate: {
      targets: [
        { targetPlaylistId: "work", status: "ACTIVE_ALLOWED", runtime: { status: "ACTIVE", fallbackCount: 2 } },
        { targetPlaylistId: "car", status: "ABSTAIN_TARGET_NOT_ALLOWLISTED", runtime: null },
        { targetPlaylistId: "gym", status: "ACTIVE_ALLOWED", runtime: { status: "ABSTAIN_UNSAFE_CONTEXT", fallbackCount: 0 } },
        { targetPlaylistId: "solo", status: "ACTIVE_ALLOWED", runtime: { status: "ACTIVE", fallbackCount: 0 } },
        { targetPlaylistId: "odd", status: "ABSTAIN_INVALID_LIMITS" },
      ],
    },
  });

  assert.deepEqual(reviews.get("work"), {
    applied: true,
    fallbackCount: 2,
    label: "aplicadas · 2 podcasts em faixa vizinha",
  });
  assert.equal(reviews.has("car"), false);
  assert.equal(reviews.get("gym")?.label, "não aplicadas: programa com ordem estrita/sequencial");
  assert.equal(reviews.get("solo")?.label, "aplicadas em todos os podcasts");
  assert.equal(reviews.get("odd")?.label, "não aplicadas: limites Curto/Médio inválidos");
});

test("missing or malformed evidence yields no reviews", () => {
  assert.equal(readPodcast08TargetReviews(null).size, 0);
  assert.equal(readPodcast08TargetReviews({ podcast08ActiveGate: { targets: "x" } }).size, 0);
});
