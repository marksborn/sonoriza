import assert from "node:assert/strict";
import test from "node:test";

import {
  scopedTargetsMaySelectPodcast,
  targetMaySelectPodcast,
} from "./podcast-refresh-applicability";

test("SEQUENCE MUSIC-only does not require proactive podcast refresh", () => {
  assert.equal(
    targetMaySelectPodcast({
      compositionMode: "SEQUENCE",
      podcastPercent: 60,
      sequencePattern: ["MUSIC"],
    }),
    false,
  );
});

test("SEQUENCE containing PODCAST requires proactive podcast refresh", () => {
  assert.equal(
    targetMaySelectPodcast({
      compositionMode: "SEQUENCE",
      podcastPercent: 0,
      sequencePattern: ["MUSIC", "PODCAST"],
    }),
    true,
  );
});

test("PROPORTION uses podcastPercent", () => {
  assert.equal(
    targetMaySelectPodcast({
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
    }),
    false,
  );
  assert.equal(
    targetMaySelectPodcast({
      compositionMode: "PROPORTION",
      podcastPercent: 25,
      sequencePattern: [],
    }),
    true,
  );
});

test("scoped target set refreshes when any target can select podcast", () => {
  assert.equal(
    scopedTargetsMaySelectPodcast([
      {
        compositionMode: "SEQUENCE",
        podcastPercent: 60,
        sequencePattern: ["MUSIC"],
      },
      {
        compositionMode: "PROPORTION",
        podcastPercent: 0,
        sequencePattern: [],
      },
    ]),
    false,
  );

  assert.equal(
    scopedTargetsMaySelectPodcast([
      {
        compositionMode: "SEQUENCE",
        podcastPercent: 60,
        sequencePattern: ["MUSIC"],
      },
      {
        compositionMode: "SEQUENCE",
        podcastPercent: 60,
        sequencePattern: ["PODCAST", "MUSIC"],
      },
    ]),
    true,
  );
});
