import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePersistedPodcastDurationSlots,
  podcastDurationConfigurationFingerprint,
} from "./podcast-duration-persistence";

const legacy = ["MUSIC", "PODCAST", "MUSIC", "PODCAST"] as const;
const target = {
  id: "work",
  compositionMode: "SEQUENCE" as const,
  sequencePattern: legacy,
  podcastDurationSlotBands: null,
};

test("#365 Gate 3: absent metadata means all ANY (legacy sequence remains intact)", () => {
  assert.deepEqual(parsePersistedPodcastDurationSlots(legacy, null), [
    "ANY", "ANY", "ANY", "ANY",
  ]);
  assert.deepEqual(parsePersistedPodcastDurationSlots(legacy, undefined), [
    "ANY", "ANY", "ANY", "ANY",
  ]);
  assert.deepEqual(legacy, ["MUSIC", "PODCAST", "MUSIC", "PODCAST"]);
});

test("#365 Gate 3: typed bands align to podcast slots only", () => {
  assert.deepEqual(
    parsePersistedPodcastDurationSlots(legacy, ["ANY", "SHORT", "ANY", "LONG"]),
    ["ANY", "SHORT", "ANY", "LONG"],
  );
});

test("#365 Gate 3: sidecar length, music and unknown values fail closed", () => {
  for (const raw of [
    [],
    ["SHORT", "SHORT", "ANY", "LONG"],
    ["ANY", "MED", "ANY", "LONG"],
    ["ANY", "SHORT"],
    ["ANY", "SHORT", "ANY", "LONG", "ANY"],
    "SHORT",
  ]) {
    assert.equal(parsePersistedPodcastDurationSlots(legacy, raw), null);
  }
  assert.equal(parsePersistedPodcastDurationSlots(["MUSIC", "UNKNOWN"], null), null);
  assert.equal(parsePersistedPodcastDurationSlots([], null), null);
  assert.deepEqual(parsePersistedPodcastDurationSlots(["PODCAST"], ["SHORT"]), ["SHORT"]);
});

test("#365 Gate 3: unchanged legacy fingerprint for null or explicit ANY bands", () => {
  const base = "legacy-config04-fingerprint";
  assert.equal(podcastDurationConfigurationFingerprint(base, [target]), base);
  assert.equal(
    podcastDurationConfigurationFingerprint(base, [{
      ...target, podcastDurationSlotBands: ["ANY", "ANY", "ANY", "ANY"],
    }]),
    base,
  );
  assert.equal(
    podcastDurationConfigurationFingerprint(base, [{
      ...target, compositionMode: "PROPORTION",
      podcastDurationSlotBands: ["ANY", "SHORT", "ANY", "LONG"],
    }]),
    base,
  );
});

test("#365 Gate 3: effective changes in slot band or limits change fingerprint", () => {
  const base = "legacy-config04-fingerprint";
  const short = {
    ...target,
    podcastDurationSlotBands: ["ANY", "SHORT", "ANY", "ANY"],
  };
  const long = {
    ...target,
    podcastDurationSlotBands: ["ANY", "LONG", "ANY", "ANY"],
  };
  const initial = podcastDurationConfigurationFingerprint(base, [short]);
  assert.notEqual(initial, base);
  assert.notEqual(initial, podcastDurationConfigurationFingerprint(base, [long]));
  assert.notEqual(initial, podcastDurationConfigurationFingerprint(base, [short], {
    shortMaxMinutes: 20, mediumMaxMinutes: 45,
  }));
});

test("#365 Gate 3: targeting/sort order does not change fingerprint", () => {
  const first = {...target, id: "a", podcastDurationSlotBands: ["ANY", "SHORT", "ANY", "ANY"]};
  const second = {...target, id: "b", podcastDurationSlotBands: ["ANY", "ANY", "ANY", "LONG"]};
  assert.equal(
    podcastDurationConfigurationFingerprint("base", [first, second]),
    podcastDurationConfigurationFingerprint("base", [second, first]),
  );
});

test("#365 Gate 3: invalid sidecar in active sequence throws; fail closed", () => {
  assert.throws(() =>
    podcastDurationConfigurationFingerprint("base", [{
      ...target, podcastDurationSlotBands: ["ANY", "INVALID", "ANY", "SHORT"],
    }]),
  );
});

test("#365 Gate 3: settings alone cannot invalidate a legacy ANY simulation", () => {
  const base = "legacy-config04-fingerprint";
  assert.equal(podcastDurationConfigurationFingerprint(base, [target], {
    shortMaxMinutes: 5, mediumMaxMinutes: 20,
  }), base);
});
