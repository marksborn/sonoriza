import assert from "node:assert/strict";
import test from "node:test";

import {
  attachUnavailableTargetSources,
  resolveTargetSourceScope,
} from "./target-source-scope";

const sources = [
  { id: "music-a", enabled: true },
  { id: "music-b", enabled: true },
  { id: "disabled-c", enabled: false },
];

test("#204 Gate 2 INHERIT_GLOBAL preserves every globally enabled source", () => {
  const result = resolveTargetSourceScope({
    targetPlaylistId: "target-a",
    targetName: "Trabalho",
    sourceScopeMode: "INHERIT_GLOBAL",
    selectedSourceIds: ["music-a"],
    sources,
  });

  assert.deepEqual(result.effectiveSourceIds, ["music-a", "music-b"]);
  assert.equal(result.plannerInfluence, false);
});

test("#204 Gate 2 SELECTED_ONLY resolves only enabled selected sources", () => {
  const result = resolveTargetSourceScope({
    targetPlaylistId: "target-a",
    targetName: "Carro",
    sourceScopeMode: "SELECTED_ONLY",
    selectedSourceIds: ["music-b", "disabled-c"],
    sources,
  });

  assert.deepEqual(result.selectedSourceIds, ["disabled-c", "music-b"]);
  assert.deepEqual(result.effectiveSourceIds, ["music-b"]);
  assert.deepEqual(result.ignoredDisabledSourceIds, ["disabled-c"]);
});

test("#204 Gate 2 never reactivates a globally disabled selected source", () => {
  const result = resolveTargetSourceScope({
    targetPlaylistId: "target-a",
    targetName: "Academia",
    sourceScopeMode: "SELECTED_ONLY",
    selectedSourceIds: ["disabled-c"],
    sources,
  });

  assert.deepEqual(result.effectiveSourceIds, []);
  assert.deepEqual(result.ignoredDisabledSourceIds, ["disabled-c"]);
});

test("#204 Gate 2 empty SELECTED_ONLY remains empty without silent fallback", () => {
  const result = resolveTargetSourceScope({
    targetPlaylistId: "target-a",
    targetName: "Avulsa",
    sourceScopeMode: "SELECTED_ONLY",
    selectedSourceIds: [],
    sources,
  });

  assert.deepEqual(result.effectiveSourceIds, []);
  assert.deepEqual(result.globallyEnabledSourceIds, ["music-a", "music-b"]);
});

test("#204 Gate 2 surfaces failures only when they belong to effective scope", () => {
  const base = resolveTargetSourceScope({
    targetPlaylistId: "target-a",
    targetName: "Carro",
    sourceScopeMode: "SELECTED_ONLY",
    selectedSourceIds: ["music-a"],
    sources,
  });

  const result = attachUnavailableTargetSources(
    base,
    new Set(["music-a", "music-b"]),
  );

  assert.deepEqual(result.unavailableEffectiveSourceIds, ["music-a"]);
});
