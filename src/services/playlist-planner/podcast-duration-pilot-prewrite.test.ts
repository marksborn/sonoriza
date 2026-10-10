import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluatePodcast08PilotPrewriteProof,
  type Podcast08PilotPrewriteInput,
} from "./podcast-duration-pilot-prewrite";

const now = Date.parse("2026-10-10T12:00:00Z");
const base: Podcast08PilotPrewriteInput = {
  requestedMode: "PILOT_REVIEW",
  explicitTargetId: "work",
  targetIdsInRun: ["work"],
  nowMs: now,
  approvedSimulation: {
    runId: "sim-01",
    completedAtMs: now - 60_000,
    status: "SUCCESS",
    qualityPassed: true,
    usedDurationBands: true,
    configurationFingerprint: "config-abc",
    finalOrderHash: "order-abc",
  },
  currentConfigurationFingerprint: "config-abc",
  currentFinalOrderHash: "order-abc",
  snapshotAtPlanning: "snapshot-1",
  snapshotAtPrewrite: "snapshot-1",
  rollbackBackup: {
    playlistId: "spotify-work",
    snapshotId: "snapshot-1",
    orderedUrisCount: 25,
    capturedAtMs: now - 60_000,
  },
  destinationPlaylistId: "spotify-work",
  singleBlock: true,
  containsStrictOrStatefulPodcast: false,
  sourcesAndCadenceRevalidated: true,
  reservationsRevalidated: true,
  spotifyPlaybackRevalidated: true,
  prewriteFenceConfirmed: true,
};
const verify = (overrides: Partial<Podcast08PilotPrewriteInput>) =>
  evaluatePodcast08PilotPrewriteProof({ ...base, ...overrides });

test("#365 Gate 7: checklist can be READY_FOR_REVIEW but can never authorize Spotify writes", () => {
  const result = verify({});
  assert.deepEqual(result, {
    gate: "PODCAST-08-7A",
    status: "READY_FOR_REVIEW",
    canWriteSpotify: false,
    intendedTargetId: "work",
    simulationRunId: "sim-01",
  });
});

test("#365 Gate 7: default OFF, flag mismatches and missing target abstain", () => {
  for (const mode of [null, "", "ACTIVE", "SHADOW", "pilot_review"]) {
    assert.equal(verify({requestedMode:mode}).status,"ABSTAIN_DISABLED");
  }
  assert.equal(verify({explicitTargetId:null}).status,"ABSTAIN_SCOPE");
  assert.equal(verify({targetIdsInRun:["work","car"]}).status,"ABSTAIN_SCOPE");
  assert.equal(verify({targetIdsInRun:["car"]}).status,"ABSTAIN_SCOPE");
});

test("#365 Gate 7: segmented targets and stateful/strict shows are forbidden", () => {
  assert.equal(verify({singleBlock:false}).status,"ABSTAIN_UNSAFE_TARGET");
  assert.equal(verify({containsStrictOrStatefulPodcast:true}).status,"ABSTAIN_UNSAFE_TARGET");
});

test("#365 Gate 7: a successful but quality-failed, legacy or absent simulation is not enough", () => {
  assert.equal(verify({approvedSimulation:null}).status,"ABSTAIN_NO_APPROVED_SIMULATION");
  assert.equal(verify({approvedSimulation:{...base.approvedSimulation!,qualityPassed:false}}).status,
    "ABSTAIN_NO_APPROVED_SIMULATION");
  assert.equal(verify({approvedSimulation:{...base.approvedSimulation!,usedDurationBands:false}}).status,
    "ABSTAIN_NO_APPROVED_SIMULATION");
  assert.equal(verify({approvedSimulation:{...base.approvedSimulation!,status:"FAILED"}}).status,
    "ABSTAIN_NO_APPROVED_SIMULATION");
});

test("#365 Gate 7: simulation is stale after 30 minutes or has future timestamp", () => {
  assert.equal(verify({approvedSimulation:{
    ...base.approvedSimulation!,completedAtMs:now-30*60_000-1,
  }}).status,"ABSTAIN_STALE_SIMULATION");
  assert.equal(verify({approvedSimulation:{
    ...base.approvedSimulation!,completedAtMs:now+1,
  }}).status,"ABSTAIN_STALE_SIMULATION");
});

test("#365 Gate 7: configuration and final order hash must match simulation", () => {
  assert.equal(verify({currentConfigurationFingerprint:"changed"}).status,
    "ABSTAIN_CONFIG_CHANGED");
  assert.equal(verify({currentFinalOrderHash:"changed"}).status,
    "ABSTAIN_PLAN_CHANGED");
});

test("#365 Gate 7: Spotify snapshot conflict rejects any proposed pilot", () => {
  assert.equal(verify({snapshotAtPrewrite:"snapshot-2"}).status,
    "ABSTAIN_SPOTIFY_SNAPSHOT_CHANGED");
  assert.equal(verify({snapshotAtPrewrite:null}).status,
    "ABSTAIN_SPOTIFY_SNAPSHOT_CHANGED");
});

test("#365 Gate 7: rollback backup is mandatory, fresh and bound to target snapshot", () => {
  assert.equal(verify({rollbackBackup:null}).status,"ABSTAIN_BACKUP_MISSING");
  assert.equal(verify({rollbackBackup:{...base.rollbackBackup!,playlistId:"other"}}).status,
    "ABSTAIN_BACKUP_MISSING");
  assert.equal(verify({rollbackBackup:{...base.rollbackBackup!,orderedUrisCount:-1}}).status,
    "ABSTAIN_BACKUP_MISSING");
  assert.equal(verify({rollbackBackup:{
    ...base.rollbackBackup!,capturedAtMs:now-11*60_000,
  }}).status,"ABSTAIN_BACKUP_MISSING");
});

test("#365 Gate 7: every authoritative prewrite validator is mandatory", () => {
  for (const key of [
    "sourcesAndCadenceRevalidated",
    "reservationsRevalidated",
    "spotifyPlaybackRevalidated",
    "prewriteFenceConfirmed",
  ] as const) {
    assert.equal(verify({[key]:false}).status,"ABSTAIN_UNVERIFIED_OPERATIONAL_GATES");
  }
});
