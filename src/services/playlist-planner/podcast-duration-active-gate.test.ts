import assert from "node:assert/strict";
import test from "node:test";
import {
  podcast08ActiveCandidateVeto,
  resolvePodcast08ActiveTargetPolicy,
} from "./podcast-duration-active-gate";

const base = {
  mode: "ACTIVE",
  targetAllowlist: "work,car",
  productiveWritesApproved: false,
  simulate: true,
  targetId: "work",
  compositionMode: "SEQUENCE" as const,
  sequencePattern: ["PODCAST" as const],
  rawBands: ["SHORT"],
  limits: { shortMaxMinutes: 30, mediumMaxMinutes: 60 },
  hasDurationBlocks: false,
};

test("#365 Gate 5: every pilot is OFF without explicit ACTIVE mode", () => {
  for (const mode of [undefined, null, "", "SHADOW", "active", "ON", "INVALID"]) {
    assert.equal(resolvePodcast08ActiveTargetPolicy({ ...base, mode }).status, "OFF");
  }
});

test("#365 Gate 5: empty and missing target allowlists never activate", () => {
  for (const targetAllowlist of [null, undefined, "", " , "]) {
    assert.equal(resolvePodcast08ActiveTargetPolicy({...base, targetAllowlist}).status,
      "ABSTAIN_NO_EXPLICIT_ALLOWLIST");
  }
  assert.equal(resolvePodcast08ActiveTargetPolicy({
    ...base, targetAllowlist:"car",
  }).status, "ABSTAIN_TARGET_NOT_ALLOWLISTED");
});

test("#365 Gate 5: simulation approval NEVER authorizes productive writes", () => {
  assert.equal(resolvePodcast08ActiveTargetPolicy({...base,simulate:false}).status,
    "ABSTAIN_REAL_WRITE_NOT_APPROVED");
  assert.equal(resolvePodcast08ActiveTargetPolicy({
    ...base,simulate:false,productiveWritesApproved:true,
  }).status, "ACTIVE_ALLOWED");
});

test("#365 Gate 5: invalid slots, legacy ANY and invalid limits abstain", () => {
  for (const rawBands of [null, ["ANY"], ["MEDIUM","SHORT"],["BAD"]]) {
    assert.equal(resolvePodcast08ActiveTargetPolicy({...base,rawBands}).status,
      "ABSTAIN_INVALID_BANDS");
  }
  assert.equal(resolvePodcast08ActiveTargetPolicy({
    ...base,limits:{shortMaxMinutes:60,mediumMaxMinutes:40},
  }).status,"ABSTAIN_INVALID_LIMITS");
});

test("#365 Gate 5: only single-block SEQUENCE is eligible for v1", () => {
  assert.equal(resolvePodcast08ActiveTargetPolicy({...base,
    compositionMode:"PROPORTION"}).status,"ABSTAIN_NOT_SEQUENCE");
  assert.equal(resolvePodcast08ActiveTargetPolicy({...base,
    hasDurationBlocks:true}).status,"ABSTAIN_NOT_SINGLE_BLOCK");
});

test("#365 Gate 5: eligible allowlisted target retains specific band and limits", () => {
  assert.deepEqual(resolvePodcast08ActiveTargetPolicy(base),{
    status:"ACTIVE_ALLOWED",
    policy:{bands:["SHORT"],limits:{shortMaxMinutes:30,mediumMaxMinutes:60}},
  });
});

test("#365 Gate 5: strict/stateful show ordering always vetoes", () => {
  const episode = {type:"PODCAST" as const,uri:"p",title:"Podcast",
    durationMs:30*60_000,programId:"show"};
  assert.equal(podcast08ActiveCandidateVeto([],[]),null);
  assert.equal(podcast08ActiveCandidateVeto([
    {...episode,podcastStrictSequence:true}
  ],[]),"ABSTAIN_STATEFUL_ORDER");
  assert.equal(podcast08ActiveCandidateVeto([],[
    {...episode,podcastSequenceStateful:true},
  ]),"ABSTAIN_STATEFUL_ORDER");
  assert.equal(podcast08ActiveCandidateVeto([episode],[]),null);
});
