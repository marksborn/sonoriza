import assert from "node:assert/strict";
import test from "node:test";

import {
  comparePodcastDurationShadow,
} from "./podcast-duration-shadow";
import type { PlanPlaylistInput } from "./planner";
import type { Candidate } from "./types";

const minute = 60_000;
function episode(uri: string, minutes: number, programId = uri): Candidate {
  return {
    type: "PODCAST",
    uri,
    title: uri,
    durationMs: minutes * minute,
    programId,
  };
}
function music(uri: string, minutes = 5): Candidate {
  return { type: "MUSIC", uri, title: uri, durationMs: minutes * minute };
}
function input(
  overrides: Partial<PlanPlaylistInput> = {},
): PlanPlaylistInput {
  return {
    rules: {
      targetDurationMs: 95 * minute,
      compositionMode: "SEQUENCE",
      podcastPercent: 50,
      sequencePattern: ["PODCAST", "MUSIC", "PODCAST"],
      maxEpisodesPerProgram: 1,
    },
    pools: {
      music: [music("music-1")],
      podcasts: [
        episode("long-70", 70),
        episode("short-20", 20),
        episode("medium-40", 40),
      ],
    },
    ...overrides,
  };
}

test("#365 Gate 4: projected sequence changes while legacy actual plan stays identical", () => {
  const snapshot = input();
  const before = JSON.stringify(snapshot);
  const { actual, evidence } = comparePodcastDurationShadow(
    snapshot,
    ["SHORT", "ANY", "LONG"],
  );
  assert.deepEqual(actual.items.map((item) => item.uri),
    ["long-70", "music-1", "short-20"]);
  assert.deepEqual(evidence.actualUris,
    ["long-70", "music-1", "short-20"]);
  assert.deepEqual(evidence.projectedUris,
    ["short-20", "music-1", "long-70"]);
  assert.equal(evidence.differentPositions, 2);
  assert.equal(evidence.status, "READY_SHADOW");
  assert.equal(evidence.plannerInfluence, false);
  assert.equal(evidence.providerReads, false);
  assert.equal(evidence.databaseReads, false);
  assert.equal(evidence.spotifyWrites, false);
  assert.equal(evidence.actualSelectionUnchanged, true);
  assert.equal(JSON.stringify(snapshot), before);
});

test("#365 Gate 4: ANY in every position yields exactly the legacy order", () => {
  const { actual, evidence } = comparePodcastDurationShadow(input(),
    ["ANY", "ANY", "ANY"]);
  assert.deepEqual(evidence.projectedUris, actual.items.map((item) => item.uri));
  assert.equal(evidence.differentPositions, 0);
  assert.equal(evidence.fallbackCount, 0);
  assert.deepEqual(evidence.slots.map((slot) => slot.requestedBand), ["ANY", "ANY"]);
});

test("#365 Gate 4: requested SHORT wins over earlier LONG without ranking by fit", () => {
  const out = comparePodcastDurationShadow(input(), ["SHORT", "ANY", "ANY"]);
  assert.equal(out.evidence.slots[0]?.selectedUri, "short-20");
  assert.equal(out.evidence.slots[0]?.fallbackApplied, false);
});

test("#365 Gate 4: LONG fallback uses MEDIUM and reports the reason", () => {
  const data = input({
    rules: {
      ...input().rules,
      targetDurationMs: 45 * minute,
      sequencePattern: ["PODCAST"],
    },
    pools: { music: [], podcasts: [
      episode("short", 10), episode("medium", 40),
    ] },
  });
  const { evidence } = comparePodcastDurationShadow(data, ["LONG"]);
  assert.equal(evidence.projectedUris?.[0], "medium");
  assert.equal(evidence.slots[0]?.requestedBand, "LONG");
  assert.equal(evidence.slots[0]?.fallbackStepBand, "MEDIUM");
  assert.equal(evidence.slots[0]?.selectedBand, "MEDIUM");
  assert.equal(evidence.slots[0]?.fallbackApplied, true);
  assert.equal(evidence.slots[0]?.reason, "NO_ELIGIBLE_EPISODE_IN_REQUESTED_BAND");
});

test("#365 Gate 4: requested band respects per-show cap on later slots", () => {
  const data = input({
    rules: {...input().rules, targetDurationMs: 70 * minute,
      sequencePattern: ["PODCAST", "PODCAST"] },
    pools: { music: [], podcasts: [
      episode("short-A", 20, "same-show"),
      episode("medium-A", 40, "same-show"),
      episode("medium-B", 40, "other-show"),
    ] },
  });
  const { evidence } = comparePodcastDurationShadow(data, ["SHORT", "MEDIUM"]);
  assert.deepEqual(evidence.projectedUris, ["short-A", "medium-B"]);
  assert.equal(evidence.slots[1]?.fallbackApplied, false);
});

test("#365 Gate 4: duration cap is never bypassed by fallback", () => {
  const data = input({
    rules: {...input().rules,
      targetDurationMs: 20 * minute,
      sequencePattern: ["PODCAST"],
      maxPodcastDurationMs: 20 * minute,
    },
    pools: { music: [], podcasts: [
      episode("long-75", 75), episode("short-20", 20),
    ] },
  });
  const { evidence } = comparePodcastDurationShadow(data, ["LONG"]);
  assert.deepEqual(evidence.projectedUris, ["short-20"]);
  assert.equal(evidence.slots[0]?.fallbackStepBand, "ANY");
  assert.equal(evidence.slots[0]?.fallbackApplied, true);
});

test("#365 Gate 4: strict event fit never truncates an episode", () => {
  const data = input({
    rules: {...input().rules, targetDurationMs: 15 * minute,
      sequencePattern: ["PODCAST"] },
    pools: { music: [], podcasts: [episode("medium-40", 40)] },
    strictDurationBoundary: true,
  });
  const { evidence } = comparePodcastDurationShadow(data, ["SHORT"]);
  assert.deepEqual(evidence.projectedUris, []);
  assert.equal(evidence.slots[0]?.reason, "NO_ELIGIBLE_EPISODE_AFTER_FALLBACK");
});

test("#365 Gate 4: effective remaining duration classifies IN_PROGRESS correctly", () => {
  const resumed = {...episode("resumed-15", 15),
    originalDurationMs: 90 * minute, resumePositionMs: 75 * minute,
    podcastListeningStatus: "IN_PROGRESS" as const,
  };
  const data = input({
    rules: {...input().rules, targetDurationMs: 15 * minute,
      sequencePattern: ["PODCAST"] },
    pools: { music: [], podcasts: [resumed] },
  });
  const { evidence } = comparePodcastDurationShadow(data, ["SHORT"]);
  assert.equal(evidence.slots[0]?.selectedBand, "SHORT");
  assert.equal(evidence.slots[0]?.selectedUri, "resumed-15");
});

test("#365 Gate 4: preserved prefix remains unchanged even for nonmatching band", () => {
  const preserved = episode("preserved-long", 70);
  const data = input({
    rules: {...input().rules, targetDurationMs: 70 * minute,
      sequencePattern: ["PODCAST"] },
    preserved: [preserved],
    pools: {music: [], podcasts: [episode("short", 20)]},
  });
  const { evidence } = comparePodcastDurationShadow(data, ["SHORT"]);
  assert.deepEqual(evidence.projectedUris, ["preserved-long"]);
  assert.equal(evidence.differentPositions, 0);
});

test("#365 Gate 4: invalid band or divider abstains without modifying legacy selection", () => {
  const data = input();
  const invalidBand = comparePodcastDurationShadow(
    data, ["LONG", "SHORT", "MEDIUM"],
  );
  assert.equal(invalidBand.evidence.status, "ABSTAIN_INVALID_CONFIGURATION");
  assert.equal(invalidBand.evidence.projectedUris, null);
  assert.deepEqual(invalidBand.actual.items.map((x) => x.uri),
    ["long-70", "music-1", "short-20"]);
  const invalidLimit = comparePodcastDurationShadow(data, ["SHORT", "ANY", "LONG"], {
    shortMaxMinutes: 60, mediumMaxMinutes: 30,
  });
  assert.equal(invalidLimit.evidence.status, "ABSTAIN_INVALID_CONFIGURATION");
});

test("#365 Gate 4: strict-show ordering must abstain rather than skip early episodes", () => {
  const strict = {...episode("show-ep-01", 70, "show"),
    podcastStrictSequence: true};
  const data = input({pools:{music:[music("m")],podcasts:[strict]}});
  const { evidence } = comparePodcastDurationShadow(data, ["SHORT", "ANY", "LONG"]);
  assert.equal(evidence.status, "ABSTAIN_STRICT_SEQUENCE");
  assert.equal(evidence.projectedUris, null);
});

test("#365 Gate 4: PROPORTION mode abstains because slots do not apply", () => {
  const data = input({rules:{...input().rules,compositionMode:"PROPORTION"}});
  const {evidence} = comparePodcastDurationShadow(data, ["SHORT", "ANY", "LONG"]);
  assert.equal(evidence.status, "ABSTAIN_UNSUPPORTED_COMPOSITION");
  assert.equal(evidence.projectedUris, null);
});

test("#365 Gate 4: nonzero sequenceStartIndex preserves calendar continuity", () => {
  const data = input({
    rules:{...input().rules,targetDurationMs:20*minute,
      sequencePattern:["MUSIC", "PODCAST"]},
    sequenceStartIndex:1,
    pools:{music:[music("m")], podcasts:[episode("short",20)]},
  });
  const {evidence} = comparePodcastDurationShadow(data, ["ANY","SHORT"]);
  assert.equal(evidence.slots[0]?.patternIndex,1);
  assert.equal(evidence.slots[0]?.position,1);
  assert.deepEqual(evidence.projectedUris,["short"]);
});

test("#365 Gate 4: candidate ordering and fallback are deterministic", () => {
  const data = input({
    rules:{...input().rules,targetDurationMs:50*minute,
      sequencePattern:["PODCAST"]},
    pools:{music:[], podcasts:[
      episode("med-first",40),episode("med-second",40),episode("short-last",15),
    ]},
  });
  const first = comparePodcastDurationShadow(data, ["LONG"]);
  const second = comparePodcastDurationShadow(data, ["LONG"]);
  assert.deepEqual(first.evidence, second.evidence);
  assert.equal(first.evidence.projectedUris?.[0],"med-first");
});
