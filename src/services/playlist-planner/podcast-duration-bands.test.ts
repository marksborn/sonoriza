import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  classifyPodcastEffectiveDuration,
  parsePodcastDurationBandLimits,
  parsePodcastDurationSequenceSlots,
  podcastDurationFallbackOrder,
  podcastDurationMatchesBand,
  previewPodcastDurationSlot,
} from "./podcast-duration-bands";

const m = (minutes: number) => minutes * 60_000;

test("#365: global defaults classify episodes at 30/60 minute boundaries", () => {
  assert.deepEqual(DEFAULT_PODCAST_DURATION_BAND_LIMITS, {
    shortMaxMinutes: 30,
    mediumMaxMinutes: 60,
  });
  assert.equal(classifyPodcastEffectiveDuration(m(20)), "SHORT");
  assert.equal(classifyPodcastEffectiveDuration(m(30)), "SHORT");
  assert.equal(classifyPodcastEffectiveDuration(m(30) + 1), "MEDIUM");
  assert.equal(classifyPodcastEffectiveDuration(m(45)), "MEDIUM");
  assert.equal(classifyPodcastEffectiveDuration(m(60)), "MEDIUM");
  assert.equal(classifyPodcastEffectiveDuration(m(60) + 1), "LONG");
  assert.equal(classifyPodcastEffectiveDuration(m(75)), "LONG");
});

test("#365: custom dividers reclassify dynamically without storing on episodes", () => {
  const limits = parsePodcastDurationBandLimits({
    shortMaxMinutes: 20,
    mediumMaxMinutes: 45,
  });
  assert.ok(limits);
  assert.equal(classifyPodcastEffectiveDuration(m(20), limits), "SHORT");
  assert.equal(classifyPodcastEffectiveDuration(m(30), limits), "MEDIUM");
  assert.equal(classifyPodcastEffectiveDuration(m(45), limits), "MEDIUM");
  assert.equal(classifyPodcastEffectiveDuration(m(46), limits), "LONG");
  assert.equal(classifyPodcastEffectiveDuration(m(46)), "MEDIUM");
});

test("#365: invalid global divider configuration is rejected, not silently repaired", () => {
  for (const value of [
    null,
    {},
    [],
    { shortMaxMinutes: 0, mediumMaxMinutes: 60 },
    { shortMaxMinutes: 30.5, mediumMaxMinutes: 60 },
    { shortMaxMinutes: "30", mediumMaxMinutes: 60 },
    { shortMaxMinutes: 60, mediumMaxMinutes: 60 },
    { shortMaxMinutes: 75, mediumMaxMinutes: 60 },
    { shortMaxMinutes: 30, mediumMaxMinutes: 1441 },
    { shortMaxMinutes: Number.NaN, mediumMaxMinutes: 60 },
  ]) {
    assert.equal(parsePodcastDurationBandLimits(value), null);
  }
  assert.throws(
    () => classifyPodcastEffectiveDuration(m(30), {
      shortMaxMinutes: 60,
      mediumMaxMinutes: 30,
    }),
    RangeError,
  );
});

test("#365: invalid or absent duration stays UNKNOWN and only matches ANY", () => {
  for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(classifyPodcastEffectiveDuration(value), "UNKNOWN");
    assert.equal(podcastDurationMatchesBand(value, "SHORT"), false);
    assert.equal(podcastDurationMatchesBand(value, "MEDIUM"), false);
    assert.equal(podcastDurationMatchesBand(value, "LONG"), false);
    assert.equal(podcastDurationMatchesBand(value, "ANY"), true);
  }
});

test("#365: resumed episodes use the canonical effective remaining duration", () => {
  // Original episode is 90 min but the canonical candidate is only 15 min left.
  const candidate = {
    originalDurationMs: m(90),
    resumePositionMs: m(75),
    durationMs: m(15),
  };
  assert.equal(classifyPodcastEffectiveDuration(candidate.durationMs), "SHORT");
});

test("#365: legacy MUSIC/PODCAST sequence maps to ANY without changing semantics", () => {
  assert.deepEqual(
    parsePodcastDurationSequenceSlots(["MUSIC", "PODCAST", "MUSIC", "PODCAST"]),
    [
      { type: "MUSIC" },
      { type: "PODCAST", podcastDurationBand: "ANY" },
      { type: "MUSIC" },
      { type: "PODCAST", podcastDurationBand: "ANY" },
    ],
  );
  assert.deepEqual(
    parsePodcastDurationSequenceSlots(["m", "p", "music", "podcast"]),
    [
      { type: "MUSIC" },
      { type: "PODCAST", podcastDurationBand: "ANY" },
      { type: "MUSIC" },
      { type: "PODCAST", podcastDurationBand: "ANY" },
    ],
  );
});

test("#365: typed slots are parsed without mutating the source", () => {
  const raw = [
    { type: "MUSIC" },
    { type: "PODCAST", podcastDurationBand: "SHORT" },
    { type: "PODCAST", podcastDurationBand: "LONG" },
  ];
  const before = JSON.stringify(raw);
  assert.deepEqual(parsePodcastDurationSequenceSlots(raw), raw);
  assert.equal(JSON.stringify(raw), before);
});

test("#365: malformed explicit slots cannot silently become ANY", () => {
  for (const raw of [
    null,
    ["MUSIC", { type: "PODCAST", podcastDurationBand: "SHORTER" }],
    [{ type: "MUSIC", podcastDurationBand: "LONG" }],
    ["MUSIC", "SOMETHING"],
    ["PODCAST", null],
    [{ type: "PODCAST", podcastDurationBand: 0 }],
  ]) {
    assert.deepEqual(parsePodcastDurationSequenceSlots(raw), []);
  }
});

test("#365: fallback is fixed, deterministic and has ANY as the final step", () => {
  assert.deepEqual(podcastDurationFallbackOrder("ANY"), ["ANY"]);
  assert.deepEqual(podcastDurationFallbackOrder("SHORT"), ["SHORT", "MEDIUM", "ANY"]);
  assert.deepEqual(podcastDurationFallbackOrder("MEDIUM"), ["MEDIUM", "SHORT", "LONG", "ANY"]);
  assert.deepEqual(podcastDurationFallbackOrder("LONG"), ["LONG", "MEDIUM", "ANY"]);
});

test("#365: requested band outranks canonical-order candidates from other bands", () => {
  const candidates = [
    { uri: "first-long", durationMs: m(85) },
    { uri: "second-short", durationMs: m(12) },
    { uri: "third-short", durationMs: m(18) },
  ];
  assert.deepEqual(previewPodcastDurationSlot(candidates, "SHORT"), {
    selected: candidates[1],
    requestedBand: "SHORT",
    fallbackStepBand: "SHORT",
    selectedBand: "SHORT",
    fallbackApplied: false,
    reason: "PRIMARY_MATCH",
  });
});

test("#365: canonical order is stable within a requested band", () => {
  const candidates = [
    { uri: "medium-01", durationMs: m(45) },
    { uri: "medium-02", durationMs: m(55) },
    { uri: "short-01", durationMs: m(8) },
  ];
  assert.equal(previewPodcastDurationSlot(candidates, "MEDIUM").selected, candidates[0]);
});

test("#365: short fallback selects MEDIUM before LONG or unknown", () => {
  const candidates = [
    { uri: "long", durationMs: m(75) },
    { uri: "medium", durationMs: m(45) },
    { uri: "unknown", durationMs: 0 },
  ];
  const chosen = previewPodcastDurationSlot(candidates, "SHORT");
  assert.equal(chosen.selected, candidates[1]);
  assert.equal(chosen.selectedBand, "MEDIUM");
  assert.equal(chosen.fallbackStepBand, "MEDIUM");
  assert.equal(chosen.fallbackApplied, true);
  assert.equal(chosen.reason, "NO_ELIGIBLE_EPISODE_IN_REQUESTED_BAND");
});

test("#365: medium fallback prioritizes SHORT over LONG", () => {
  const candidates = [
    { uri: "long", durationMs: m(90) },
    { uri: "short", durationMs: m(22) },
  ];
  assert.equal(previewPodcastDurationSlot(candidates, "MEDIUM").selected, candidates[1]);
});

test("#365: long fallback prioritizes MEDIUM", () => {
  const candidates = [
    { uri: "short", durationMs: m(15) },
    { uri: "medium", durationMs: m(50) },
  ];
  assert.equal(previewPodcastDurationSlot(candidates, "LONG").selected, candidates[1]);
});

test("#365: UNKNOWN remains eligible only once the ANY fallback step is reached", () => {
  const unknown = { uri: "unknown", durationMs: null };
  const chosen = previewPodcastDurationSlot([unknown], "LONG");
  assert.equal(chosen.selected, unknown);
  assert.equal(chosen.selectedBand, "UNKNOWN");
  assert.equal(chosen.fallbackStepBand, "ANY");
  assert.equal(chosen.fallbackApplied, true);
});

test("#365: ANY selects the first candidate without changing legacy ordering", () => {
  const candidates = [
    { uri: "unknown", durationMs: null },
    { uri: "medium", durationMs: m(45) },
  ];
  const chosen = previewPodcastDurationSlot(candidates, "ANY");
  assert.equal(chosen.selected, candidates[0]);
  assert.equal(chosen.fallbackApplied, false);
  assert.equal(chosen.selectedBand, "UNKNOWN");
});

test("#365: empty eligible pool is a safe no-candidate result", () => {
  assert.deepEqual(previewPodcastDurationSlot([], "SHORT"), {
    selected: null,
    requestedBand: "SHORT",
    fallbackStepBand: null,
    selectedBand: null,
    fallbackApplied: false,
    reason: "NO_ELIGIBLE_EPISODE_AFTER_FALLBACK",
  });
});
