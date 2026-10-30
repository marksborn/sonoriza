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
    ...rules,targetDurationMs:60*min,
  };
  input.pools.podcasts=[
    episode("long",70,"long"),
    episode("short",20,"show-A"),
    episode("another-short",15,"show-A"),
    episode("medium",35,"show-B"),
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

test("#365: strict shows use bands per show without skipping canonical order", () => {
  const input=buildInput(true);
  input.pools.podcasts=[
    {...episode("episode-01",70,"show"),podcastStrictSequence:true},
    {...episode("episode-02",20,"show"),podcastStrictSequence:true},
  ];
  const decisions:Array<{status:string;fallbackCount:number}>=[];
  const out=planRun({...input,
    onPodcast08ActiveDecision: ({status,fallbackCount})=>decisions.push({status,fallbackCount}),
  });
  // SHORT cannot take episode-02 ahead of pending episode-01; the fallback
  // chain reaches ANY and places episode-01, never episode-02 first.
  assert.deepEqual(out.targets[0]?.result.items.map(x=>x.uri),["episode-01"]);
  assert.deepEqual(decisions,[{status:"ACTIVE",fallbackCount:1}]);
});

test("#365: an ordered show waits while another show fills the band", () => {
  const input=buildInput(true);
  input.pools.podcasts=[
    {...episode("serial-01",70,"serial"),podcastStrictSequence:true},
    {...episode("serial-02",20,"serial"),podcastStrictSequence:true},
    {...episode("traversal-01",65,"traversal"),podcastSequenceStateful:true},
    {...episode("traversal-02",15,"traversal"),podcastSequenceStateful:true},
    episode("free-short",25,"free"),
  ];
  const decisions:string[]=[];
  const out=planRun({...input,onPodcast08ActiveDecision:e=>decisions.push(e.status)});
  const uris=out.targets[0]!.result.items.map(x=>x.uri);
  assert.equal(uris[0],"free-short");
  assert.equal(uris.includes("serial-02"),false);
  assert.equal(uris.includes("traversal-02"),false);
  assert.deepEqual(decisions,["ACTIVE"]);
});

test("#365: ordered shows are protected the same way on segmented targets", () => {
  const input=buildInput(true);
  input.targets[0]!.durationBlocks=[
    {key:"event-one",targetDurationMs:80*min},
    {key:"event-two",targetDurationMs:80*min},
  ];
  input.pools.podcasts=[
    {...episode("serial-01",70,"serial"),podcastStrictSequence:true},
    {...episode("serial-02",20,"serial"),podcastStrictSequence:true},
    episode("free-short",25,"free"),
  ];
  const decisions:string[]=[];
  const out=planRun({...input,onPodcast08ActiveDecision:e=>decisions.push(e.status)});
  const uris=out.targets[0]!.result.items.map(x=>x.uri);
  assert.equal(uris.includes("serial-02"),false);
  assert.deepEqual(decisions,["ACTIVE"]);
});

test("#365: a preserved KEEP_FILLED prefix with ordered shows still abstains", () => {
  const input=buildInput(true);
  const kept={...episode("kept",20,"serial"),podcastStrictSequence:true};
  const decisions:string[]=[];
  planRun({...input,
    preservedByTargetId:new Map([["work",[kept]]]),
    onPodcast08ActiveDecision:e=>decisions.push(e.status),
  });
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

test("#365 PER_EVENT: bands apply per slot inside each event, never across", () => {
  const decisions: Array<{ status: string; fallbackCount: number }> = [];
  const input: PlanRunInput = {
    pools: {
      music: [],
      podcasts: [
        episode("long-a", 70, "show-long-a"),
        episode("long-b", 75, "show-long-b"),
        episode("short-a", 20, "show-short-a"),
        episode("short-b", 25, "show-short-b"),
      ],
    },
    targets: [{
      targetPlaylistId: "work",
      name: "Trabalho",
      priority: 0,
      rules: { ...rules, targetDurationMs: 200 * min },
      durationBlocks: [
        { key: "E1", targetDurationMs: 100 * min },
        { key: "E2", targetDurationMs: 100 * min },
      ],
      podcast08ActivePolicy: policy,
    }],
    onPodcast08ActiveDecision: ({ status, fallbackCount }) =>
      decisions.push({ status, fallbackCount }),
  };

  const out = planRun(input);
  const items = out.targets[0]!.result.items;
  assert.deepEqual(
    items.map((item) => [item.planningBlockIndex, item.uri]),
    [[0, "short-a"], [0, "long-a"], [1, "short-b"], [1, "long-b"]],
  );
  assert.deepEqual(decisions, [{ status: "ACTIVE", fallbackCount: 0 }]);
  for (const block of out.targets[0]!.result.stats.segmentation?.blocks ?? []) {
    assert.ok(block.filledDurationMs <= block.targetDurationMs);
  }

  const legacy = planRun({ ...input, targets: [{ ...input.targets[0]!, podcast08ActivePolicy: undefined }] });
  assert.equal(legacy.targets[0]!.result.items[0]!.uri, "long-a");
});

test("#365 PER_EVENT: fallback counts are summed across events", () => {
  const decisions: Array<{ status: string; fallbackCount: number }> = [];
  planRun({
    pools: {
      music: [],
      podcasts: [episode("medium-a", 45, "a"), episode("medium-b", 45, "b")],
    },
    targets: [{
      targetPlaylistId: "work",
      name: "Trabalho",
      priority: 0,
      rules: { ...rules, targetDurationMs: 100 * min, sequencePattern: ["PODCAST"] },
      durationBlocks: [
        { key: "E1", targetDurationMs: 50 * min },
        { key: "E2", targetDurationMs: 50 * min },
      ],
      podcast08ActivePolicy: { ...policy, bands: ["SHORT"] },
    }],
    onPodcast08ActiveDecision: ({ status, fallbackCount }) =>
      decisions.push({ status, fallbackCount }),
  });
  assert.deepEqual(decisions, [{ status: "ACTIVE", fallbackCount: 2 }]);
});
