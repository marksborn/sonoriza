import assert from "node:assert/strict";
import test from "node:test";

import { canSimulatePlaybackReserveByCapability } from "./playback-reserve-capability-simulation";

const base = {
  simulate: true,
  selectedTargetCount: 1,
  explicitSingleTargetScope: true,
  targetEnabled: true,
  targetLinkedToSpotify: true,
  updatePolicy: "REBUILD_DAILY",
  reserveMode: "MUSIC_TRACKS" as const,
  globalRuntimeMode: "ACTIVE",
  capabilitySimulationMode: "ACTIVE",
};

test("B1.2 simulation-by-capability is OFF unless explicitly enabled", () => {
  assert.equal(canSimulatePlaybackReserveByCapability({...base,capabilitySimulationMode:undefined}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,capabilitySimulationMode:"OFF"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,capabilitySimulationMode:"SHADOW"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,capabilitySimulationMode:"invalid"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability(base), true);
});

test("B1.2 never extends real Spotify generation beyond legacy allowlist", () => {
  assert.equal(canSimulatePlaybackReserveByCapability({...base,simulate:false}), false);
});

test("B1.2 respects single target, enabled, linked and active policy", () => {
  assert.equal(canSimulatePlaybackReserveByCapability({...base,selectedTargetCount:2}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,selectedTargetCount:0}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,explicitSingleTargetScope:false}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,targetEnabled:false}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,targetLinkedToSpotify:false}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,reserveMode:"NONE"}), false);
});

test("B1.2 does not bypass maintenance policy and global OFF/SHADOW", () => {
  assert.equal(canSimulatePlaybackReserveByCapability({...base,updatePolicy:"MANUAL"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,globalRuntimeMode:"OFF"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,globalRuntimeMode:"SHADOW"}), false);
  assert.equal(canSimulatePlaybackReserveByCapability({...base,updatePolicy:"KEEP_FILLED"}), true);
});
