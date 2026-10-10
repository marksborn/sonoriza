import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type PlanRunInput } from "./plan-run";
import { resolvePodcast08ActiveTargetPolicy } from "./podcast-duration-active-gate";
import type { Candidate } from "./types";

const min = 60_000;
const episode = (uri: string, durationMinutes: number, show: string): Candidate => ({
  type: "PODCAST", uri, durationMs: durationMinutes * min,
  programId: show, title: uri,
});
const rules = {
  targetDurationMs: 90 * min,
  compositionMode: "SEQUENCE" as const,
  podcastPercent: 100,
  sequencePattern: ["PODCAST" as const, "PODCAST" as const],
  maxEpisodesPerProgram: 1,
};
const policy = {
  bands: ["SHORT" as const, "LONG" as const],
  limits: { shortMaxMinutes: 30, mediumMaxMinutes: 60 },
};
function buildInput(active = false): PlanRunInput {
  return {
    pools: {
      music: [],
      podcasts: [
        episode("long-first", 70, "long"),
        episode("short-next", 20, "short"),
        episode("medium-last", 45, "medium"),
      ],
    },
    targets: [{
      targetPlaylistId:"work",name:"Trabalho",priority:0,
      rules,
      ...(active ? {podcast08ActivePolicy:policy}:{}),
    }],
  };
}

test("#365 Gate 5: OFF returns canonical legacy selection without change", () => {
  const legacy = planRun(buildInput());
  assert.deepEqual(legacy.targets[0]?.result.items.map((item)=>item.uri),
    ["long-first", "short-next"]);
});

test("#365 Gate 5: ACTIVE chooses SHORT first and LONG second with same canonical guards", () => {
  const decisions: Array<{status:string;fallbackCount:number}> = [];
  const out = planRun({
    ...buildInput(true),
    onPodcast08ActiveDecision: ({status,fallbackCount}) =>
      decisions.push({status,fallbackCount}),
  });
  assert.deepEqual(out.targets[0]?.result.items.map((item)=>item.uri),
    ["short-next", "long-first"]);
  assert.deepEqual(decisions,[{status:"ACTIVE",fallbackCount:0}]);
  assert.equal(out.targets[0]?.result.stats.compositionQualityPassed,true);
});

test("#365 Gate 5: fallback remains subject to duration fit and show cap", () => {
  const input=buildInput(true);
  input.targets[0]!.rules={
    ...rules,targetDurationMs:35*min,
  };
  input.pools.podcasts=[
    episode("long",70,"long"),
    episode("short",20,"show-A"),
    episode("another-short",15,"show-A"),
    episode("medium",30,"show-B"),
  ];
  const out=planRun(input);
  assert.deepEqual(out.targets[0]?.result.items.map((item)=>item.uri),["short","medium"]);
});

test("#365 Gate 5: global URI reservations remain authoritative across targets", () => {
  const input=buildInput(true);
  input.targets=[
    {
      targetPlaylistId:"first",name:"First",priority:0,
      rules:{...rules,targetDurationMs:20*min,sequencePattern:["PODCAST"]},
    },
    input.targets[0]!,
  ];
  const out=planRun(input);
  const first=new Set(out.targets[0]!.result.items.map(x=>x.uri));
  const second=new Set(out.targets[1]!.result.items.map(x=>x.uri));
  for(const uri of first) assert.equal(second.has(uri),false);
});

test("#365 Gate 5: strict episodes abstain and never skip canonical show order", () => {
  const input=buildInput(true);
  input.pools.podcasts=[
    {...episode("episode-01",70,"show"),podcastStrictSequence:true},
    {...episode("episode-02",20,"show"),podcastStrictSequence:true},
  ];
  const decisions:string[]=[];
  const out=planRun({...input,
    onPodcast08ActiveDecision: e=>decisions.push(e.status),
  });
  assert.deepEqual(out.targets[0]?.result.items.map(x=>x.uri),["episode-01"]);
  assert.deepEqual(decisions,["ABSTAIN_UNSAFE_CONTEXT"]);
});

test("#365 Gate 5: stateful episode ordering also abstains", () => {
  const input=buildInput(true);
  input.pools.podcasts=[
    {...episode("p1",60,"show"),podcastSequenceStateful:true},
  ];
  const decisions:string[]=[];
  planRun({...input,onPodcast08ActiveDecision:e=>decisions.push(e.status)});
  assert.deepEqual(decisions,["ABSTAIN_UNSAFE_CONTEXT"]);
});

test("#365 Gate 5: segmented targets abstain to unchanged canonical multi-event logic", () => {
  const input=buildInput(true);
  input.targets[0]!.durationBlocks=[
    {key:"event-one",targetDurationMs:20*min},
    {key:"event-two",targetDurationMs:20*min},
  ];
  const decisions:string[]=[];
  planRun({...input,onPodcast08ActiveDecision:e=>decisions.push(e.status)});
  assert.deepEqual(decisions,["ABSTAIN_UNSAFE_CONTEXT"]);
});

test("#365 Gate 5: ONLY allowlisted simulation can pass the active policy", () => {
  const requested=resolvePodcast08ActiveTargetPolicy({
    mode:"ACTIVE",targetAllowlist:"work",productiveWritesApproved:false,
    simulate:true,targetId:"work",compositionMode:"SEQUENCE",
    sequencePattern:rules.sequencePattern,rawBands:policy.bands,
    limits:policy.limits,hasDurationBlocks:false,
  });
  assert.equal(requested.status,"ACTIVE_ALLOWED");
  const refused=resolvePodcast08ActiveTargetPolicy({
    mode:"ACTIVE",targetAllowlist:"work",productiveWritesApproved:false,
    simulate:false,targetId:"work",compositionMode:"SEQUENCE",
    sequencePattern:rules.sequencePattern,rawBands:policy.bands,
    limits:policy.limits,hasDurationBlocks:false,
  });
  assert.equal(refused.status,"ABSTAIN_REAL_WRITE_NOT_APPROVED");
});
