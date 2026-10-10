import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { planRun, type PlanRunInput } from "./plan-run";
import type { Candidate } from "./types";
import {
  evaluatePodcast08FinalSimulationShadow,
  type Podcast08CapturedContext,
} from "./podcast-duration-simulation-shadow";

const m = (x: number) => x * 60_000;
const episode = (uri: string, minutes: number, showId: string): Candidate => ({
  type: "PODCAST", uri, title: uri, durationMs: m(minutes), programId: showId,
});
const rules = {
  targetDurationMs: m(50),
  compositionMode: "SEQUENCE" as const,
  podcastPercent: 100,
  sequencePattern: ["PODCAST" as const],
  maxEpisodesPerProgram: 1,
};

function runScoped(input: Omit<PlanRunInput, "onPodcast08SingleBlockContext">) {
  const contexts = new Map<string, Podcast08CapturedContext>();
  const finalPlan = planRun({
    ...input,
    onPodcast08SingleBlockContext: (entry) => {
      contexts.set(entry.targetPlaylistId, { input: entry.input });
    },
  });
  return { contexts, finalPlan };
}

test("#365 integration: captures canonical source-scoped pool and preserves actual sequence", () => {
  const { contexts, finalPlan } = runScoped({
    pools: {
      music: [],
      podcasts: [
        {...episode("source-A-long", 45, "show-long"), sourcePlaylistId: "A"},
        {...episode("source-B-short", 15, "show-short"), sourcePlaylistId: "B"},
        {...episode("source-A-short", 20, "show-short-A"), sourcePlaylistId: "A"},
      ],
    },
    targets: [{ targetPlaylistId: "work", name: "Trabalho", priority: 0, rules }],
    sourceIdsByTargetId: new Map([["work", new Set(["A"])]]),
  });
  assert.deepEqual(finalPlan.targets[0]?.result.items.map((i) => i.uri), ["source-A-long"]);
  assert.deepEqual(contexts.get("work")?.input.pools.podcasts.map((c) => c.uri),
    ["source-A-long", "source-A-short"]);
  const evidence = evaluatePodcast08FinalSimulationShadow({
    finalPlan, contexts,
    bandsByTargetId: new Map([["work", ["SHORT"]]]),
  });
  assert.equal(evidence.targets[0]?.status, "READY_SHADOW");
  assert.equal(evidence.targets[0]?.actualCount, 1);
  assert.equal(evidence.targets[0]?.projectedCount, 1);
  assert.equal(evidence.targets[0]?.differentPositions, 1);
  assert.notEqual(evidence.targets[0]?.actualOrderHash, evidence.targets[0]?.projectedOrderHash);
  assert.equal(evidence.plannerInfluence, false);
  assert.equal(evidence.spotifyWrites, false);
  assert.deepEqual(finalPlan.targets[0]?.result.items.map((i) => i.uri), ["source-A-long"]);
});

test("#365 integration: captured context respects higher-priority destination reservations", () => {
  const { contexts, finalPlan } = runScoped({
    pools: {
      music: [],
      podcasts: [
        episode("first", 20, "show-first"),
        episode("second", 25, "show-second"),
      ],
    },
    targets: [
      {targetPlaylistId: "firstTarget", name: "One", priority: 0,
       rules: {...rules, targetDurationMs: m(20)}},
      {targetPlaylistId: "secondTarget", name: "Two", priority: 1,
       rules: {...rules, targetDurationMs: m(25)}},
    ],
  });
  assert.deepEqual(finalPlan.targets.map((target) =>
    target.result.items.map((item) => item.uri)), [["first"], ["second"]]);
  const captured = contexts.get("secondTarget")!.input;
  assert.equal(new Set(captured.reserved).has("first"), true);
  const evidence = evaluatePodcast08FinalSimulationShadow({
    finalPlan, contexts,
    bandsByTargetId: new Map([["secondTarget", ["LONG"]]]),
  });
  assert.equal(evidence.targets[0]?.status, "READY_SHADOW");
  assert.equal(evidence.targets[0]?.differentPositions, 0);
});

test("#451 integration: strict heads from scoped canonical planner can compete across shows", () => {
  const strictEpisode = (uri: string, minutes: number, show: string) => ({
    ...episode(uri, minutes, show),
    podcastStrictSequence: true,
    podcastSequenceStateful: false,
    sourcePlaylistId: "allowed",
  });
  const strictRules = {
    ...rules,
    targetDurationMs: m(90),
    sequencePattern: ["PODCAST" as const, "MUSIC" as const, "PODCAST" as const],
    maxEpisodesPerProgram: 2,
  };
  const { contexts, finalPlan } = runScoped({
    pools: {
      music: [{
        type: "MUSIC", uri: "music-5", durationMs: m(5), title: "music-5",
        sourcePlaylistId: "allowed",
      }],
      podcasts: [
        strictEpisode("show-A-head-long-70", 70, "show-A"),
        strictEpisode("show-A-later-short-20", 20, "show-A"),
        strictEpisode("show-B-head-short-15", 15, "show-B"),
        {...strictEpisode("outside-target", 10, "show-C"), sourcePlaylistId:"blocked"},
      ],
    },
    targets: [{
      targetPlaylistId: "work", name: "Trabalho", priority: 0,
      rules: strictRules,
    }],
    sourceIdsByTargetId: new Map([["work", new Set(["allowed"])]]),
  });
  const legacyUris = finalPlan.targets[0]!.result.items.map((x) => x.uri);
  assert.deepEqual(legacyUris,
    ["show-A-head-long-70", "music-5", "show-B-head-short-15"]);
  const ctx = contexts.get("work")!;
  assert.equal(ctx.input.pools.podcasts.some(p => p.uri === "outside-target"), false);
  const evidence = evaluatePodcast08FinalSimulationShadow({
    finalPlan, contexts, bandsByTargetId: new Map([
      ["work", ["SHORT", "ANY", "ANY"]],
    ]),
  });
  assert.equal(evidence.targets[0]?.status, "READY_SHADOW");
  assert.equal(evidence.targets[0]?.differentPositions, 2);
  assert.equal(evidence.targets[0]?.sampledSlots[0]?.fallbackApplied, false);
  assert.equal(evidence.targets[0]?.sampledSlots[1]?.fallbackApplied, false);
  // It may choose the short head from show B, never show A's later short
  // while show A's mandatory long head remains pending.
  assert.deepEqual(finalPlan.targets[0]!.result.items.map(x => x.uri),
    legacyUris);
  assert.equal(evidence.spotifyWrites, false);
  assert.equal(evidence.plannerInfluence, false);
});

test("#365 integration: upstream postprocessing changes trigger abstention", () => {
  const { contexts, finalPlan } = runScoped({
    pools: { music: [], podcasts: [
      episode("original", 20, "A"), episode("other", 20, "B"),
    ] },
    targets: [{targetPlaylistId:"work",name:"Trabalho",priority:0,
      rules: {...rules, targetDurationMs:m(20)}}],
  });
  const substitutedPlan = {
    ...finalPlan,
    targets: finalPlan.targets.map((target) => ({
      ...target,
      result: {...target.result,
        items: target.result.items.map((item) => ({
          ...item, uri:"upstream-changed",
        })),
      },
    })),
  };
  const result = evaluatePodcast08FinalSimulationShadow({
    finalPlan: substitutedPlan, contexts,
    bandsByTargetId: new Map([["work", ["SHORT"]]]),
  });
  assert.equal(result.targets[0]?.status, "ABSTAIN_NON_CANONICAL_BASELINE");
  assert.equal(result.targets[0]?.projectedOrderHash, null);
});

test("#365 integration: unavailable per-event context must abstain", () => {
  const { finalPlan } = runScoped({
    pools: {music: [], podcasts:[episode("eligible",20,"A")]},
    targets: [{targetPlaylistId:"work",name:"Trabalho",priority:0,
      rules:{...rules,targetDurationMs:m(20)}}],
  });
  const evidence = evaluatePodcast08FinalSimulationShadow({
    finalPlan, contexts:new Map(),
    bandsByTargetId:new Map([["work", ["SHORT"]]]),
  });
  assert.equal(evidence.targets[0]?.status,"ABSTAIN_NO_SINGLE_BLOCK_CONTEXT");
});

test("#365 integration: production scheduling is excluded by both simulation and opt-in gating", () => {
  const code = readFileSync("src/jobs/generate-playlists-incremental.ts","utf8");
  assert.match(code,
    /const podcast08ShadowEnabled\s*=\s*simulate && \(process\.env\.PODCAST08_SHADOW_MODE === "SHADOW" \|\|/);
  assert.match(code, /const podcast08Contexts = new Map/);
});
