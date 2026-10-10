import assert from "node:assert/strict";
import test from "node:test";

import {
  assessPodcast08PilotReadiness,
  podcast08UnapprovedRealPilotTargetIds,
} from "./podcast-duration-pilot-readiness";

const valid = () => ({
  targetId: "work",
  allowlistedTargetIds: ["work"],
  currentConfigurationFingerprint: "current-config-sha",
  simulation: {
    status: "SUCCESS" as const,
    summary: {
      configurationFingerprint: "current-config-sha",
      targetScope: ["work"],
      podcast08SimulationOnly: true,
      podcast08ActiveGate: {
        simulate: true,
        spotifyWritesEnabled: false,
        realRunApprovalEligible: false,
        targets: [{
          targetPlaylistId: "work",
          status: "ACTIVE_ALLOWED",
          runtime: { status: "ACTIVE", fallbackCount: 1 },
        }],
      },
      collectionComplete: true,
      inconclusive: false,
      qualityFailures: [],
    },
  },
  simulationSpotifySnapshotId: "snapshot-42",
  currentSpotifySnapshotId: "snapshot-42",
  rollback: {
    capturedOrderHash: "order-sha",
    capturedSnapshotId: "snapshot-42",
    restoreProcedureReviewed: true,
  },
  ciGreen: true,
  operationalReviewApproved: true,
});

test("#365 Gate 7: complete evidence permits REVIEW only, NEVER a Spotify write", () => {
  const assessment = assessPodcast08PilotReadiness(valid());
  assert.deepEqual(assessment, {
    gate: 7,
    status: "REVIEW_CANDIDATE",
    reasons: [],
    targetId: "work",
    productiveWritesAllowed: false,
    requiresSeparateImplementation: true,
  });
});

test("#365 Gate 7: legacy approved simulation cannot prove banded pilot", () => {
  const input = valid();
  input.simulation.summary.podcast08SimulationOnly = false;
  const result = assessPodcast08PilotReadiness(input);
  assert.equal(result.status, "BLOCKED");
  assert.ok(result.reasons.includes("SIMULATION_NOT_EXPERIMENTAL"));
});

test("#365 Gate 7: experimental selection must be ACTIVE and never write enabled", () => {
  const input = valid();
  input.simulation.summary.podcast08ActiveGate.targets[0]!.runtime.status = "ABSTAIN_UNSAFE_CONTEXT";
  const result = assessPodcast08PilotReadiness(input);
  assert.ok(result.reasons.includes("SIMULATION_NOT_ACTIVE"));
});

test("#365 Gate 7: other target or multiple target pilot is rejected", () => {
  const input = valid();
  input.allowlistedTargetIds = ["work","car"];
  const result = assessPodcast08PilotReadiness(input);
  assert.ok(result.reasons.includes("NO_SINGLE_TARGET"));
  assert.ok(result.reasons.includes("TARGET_NOT_ALLOWLISTED"));
});

test("#365 Gate 7: changed snapshot or missing rollback proof blocks pilot", () => {
  const changed = valid();
  changed.currentSpotifySnapshotId = "snapshot-new";
  const result = assessPodcast08PilotReadiness(changed);
  assert.ok(result.reasons.includes("SNAPSHOT_CHANGED"));
  assert.ok(result.reasons.includes("ROLLBACK_NOT_READY"));
  const noBackup = valid();
  noBackup.rollback.capturedOrderHash = "";
  assert.ok(assessPodcast08PilotReadiness(noBackup).reasons.includes("ROLLBACK_NOT_READY"));
});

test("#365 Gate 7: changed configuration fingerprint blocks old simulation", () => {
  const input=valid();
  input.currentConfigurationFingerprint="another-config";
  assert.ok(assessPodcast08PilotReadiness(input).reasons.includes(
    "SIMULATION_FINGERPRINT_MISMATCH",
  ));
});

test("#365 Gate 7: incomplete run and quality failures are independently blocked", () => {
  const input=valid();
  input.simulation.summary.collectionComplete=false;
  input.simulation.summary.qualityFailures.push({targetId:"work"});
  const reasons=assessPodcast08PilotReadiness(input).reasons;
  assert.ok(reasons.includes("SIMULATION_COLLECTION_INCOMPLETE"));
  assert.ok(reasons.includes("SIMULATION_HAS_QUALITY_FAILURES"));
});

test("#365 Gate 7: CI or reviewer approval absent cannot pass review", () => {
  const input=valid();
  input.ciGreen=false;
  input.operationalReviewApproved=false;
  const reasons=assessPodcast08PilotReadiness(input).reasons;
  assert.ok(reasons.includes("CI_NOT_GREEN"));
  assert.ok(reasons.includes("REVIEW_NOT_APPROVED"));
});

test("#365 Gate 7: fail-closed on missing/corrupt experimental evidence", () => {
  const input = valid();
  input.simulation.summary.podcast08ActiveGate.targets=[];
  input.simulation.summary.qualityFailures=[];
  assert.ok(assessPodcast08PilotReadiness(input).reasons.includes("SIMULATION_NOT_ACTIVE"));
});

test("#365 Gate 7: normal real runs remain unaffected with OFF/SHADOW modes", () => {
  for(const mode of [undefined, null, "SHADOW", "OFF"]) {
    assert.deepEqual(podcast08UnapprovedRealPilotTargetIds({
      simulate:false,activeMode:mode,allowlistCsv:"work",runTargetIds:["work","car"],
    }),[]);
  }
});

test("#365 Gate 7: explicitly allowlisted real write attempt is rejected", () => {
  assert.deepEqual(podcast08UnapprovedRealPilotTargetIds({
    simulate:false,activeMode:"ACTIVE",allowlistCsv:"work",runTargetIds:["work","car"],
  }),["work"]);
  assert.deepEqual(podcast08UnapprovedRealPilotTargetIds({
    simulate:true,activeMode:"ACTIVE",allowlistCsv:"work",runTargetIds:["work"],
  }),[]);
  assert.deepEqual(podcast08UnapprovedRealPilotTargetIds({
    simulate:false,activeMode:"ACTIVE",allowlistCsv:"",runTargetIds:["work"],
  }),[]);
});
