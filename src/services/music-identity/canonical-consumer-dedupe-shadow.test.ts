import assert from "node:assert/strict";
import test from "node:test";

import type { Gate4BComponent } from "./canonical-component-closure-shadow";
import { projectGate4CUniverse } from "./canonical-consumer-dedupe-shadow";

function component(
  id: string,
  members: string[],
  options: {
    decision?: Gate4BComponent["componentDecision"];
    preferenceState?: Gate4BComponent["preferenceState"];
    containsExcludedPreference?: boolean;
  } = {},
): Gate4BComponent {
  const decision = options.decision ?? "SAFE_CANONICAL_COMPONENT";
  return {
    componentId: id,
    memberProviderTrackIds: [...members].sort(),
    legacyRecordingIdentityIds: members.map((member) => `recording-${member}`).sort(),
    memberCount: members.length,
    legacyRecordingCount: members.length,
    candidateEdgeCount: Math.max(1, members.length - 1),
    internalPairCount: (members.length * (members.length - 1)) / 2,
    expectedInternalPairCount: (members.length * (members.length - 1)) / 2,
    safeInternalPairs: decision === "SAFE_CANONICAL_COMPONENT" ? 1 : 0,
    blockedInternalPairs: decision === "SAFE_CANONICAL_COMPONENT" ? 0 : 1,
    normalizedIsrcs: ["USGATE4C00001"],
    tracksMissingIsrc: 0,
    minProviderDurationMs: 180_000,
    maxProviderDurationMs: 181_000,
    maxDurationDeltaMs: 1_000,
    tracksMissingProviderDuration: 0,
    preferenceState: options.preferenceState ?? "NO_EXPLICIT_TRACK_PREFERENCE",
    explicitPreferencePolicies:
      options.preferenceState === "IDENTICAL_EXPLICIT_TRACK_PREFERENCE"
        ? [options.containsExcludedPreference ? "EXCLUDED" : "PREFERRED"]
        : [],
    explicitPreferenceSources:
      options.preferenceState === "IDENTICAL_EXPLICIT_TRACK_PREFERENCE"
        ? ["USER_EXPLICIT"]
        : [],
    containsExcludedPreference: options.containsExcludedPreference ?? false,
    componentDecision: decision,
    legacy: { recordingIdentityCount: members.length },
    canonicalShadow: {
      hypotheticalRecordingCount:
        decision === "SAFE_CANONICAL_COMPONENT" ? 1 : members.length,
      representativeRecordingIdentityId: null,
      representativeProviderTrackId: null,
      representativeSelection: "NOT_SELECTED_IN_GATE4B",
    },
  };
}

function occurrence(sourcePlaylistId: string, providerTrackId: string) {
  return {
    sourcePlaylistId,
    providerTrackId,
    uri: `spotify:track:${providerTrackId}`,
  };
}

test("safe recording aliases collide canonically without selecting a representative", () => {
  const projection = projectGate4CUniverse({
    occurrences: [occurrence("source-a", "standard"), occurrence("source-a", "remaster")],
    components: [component("gate4b:safe", ["standard", "remaster"])],
  });

  assert.equal(projection.distinctProviderTrackIds, 2);
  assert.equal(projection.collisionComponents, 1);
  assert.equal(projection.hypotheticalCanonicalRecordingKeys, 1);
  assert.equal(projection.hypotheticalReduction, 1);
  assert.equal(projection.redundantProviderTracksByCanonicalRecording, 1);
  assert.deepEqual(projection.collisionComponentIds, ["gate4b:safe"]);
  assert.equal(projection.collisionSamples[0]?.decision, "WOULD_COLLAPSE_COMPONENT");
  assert.equal(projection.collisionSamples[0]?.representativeProviderTrackId, null);
  assert.equal(
    projection.collisionSamples[0]?.representativeSelection,
    "NOT_SELECTED_IN_GATE4C",
  );
});

test("blocked preference component never reduces the legacy set", () => {
  const blocked = component("gate4b:blocked", ["a", "b"], {
    decision: "BLOCKED_PREFERENCE_SEMANTICS",
    preferenceState: "PREFERENCE_PRESENCE_DIVERGENCE",
    containsExcludedPreference: true,
  });
  const projection = projectGate4CUniverse({
    occurrences: [occurrence("source-a", "a"), occurrence("source-a", "b")],
    components: [blocked],
  });

  assert.equal(projection.safeComponentMappedTracks, 0);
  assert.equal(projection.blockedComponentTracks, 2);
  assert.equal(projection.legacyOnlyTracks, 2);
  assert.equal(projection.collisionComponents, 0);
  assert.equal(projection.hypotheticalReduction, 0);
});

test("identical explicit preference permits comparison but is never propagated", () => {
  const safe = component("gate4b:preferred", ["a", "b"], {
    preferenceState: "IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
  });
  const projection = projectGate4CUniverse({
    occurrences: [occurrence("source-a", "a"), occurrence("source-a", "b")],
    components: [safe],
  });

  assert.equal(projection.hypotheticalReduction, 1);
  assert.equal(
    projection.collisionSamples[0]?.preferenceState,
    "IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
  );
  assert.equal(projection.collisionSamples[0]?.containsExcludedPreference, false);
});

test("aliases split across sources still collide in one target consumer universe", () => {
  const projection = projectGate4CUniverse({
    occurrences: [occurrence("source-a", "a"), occurrence("source-b", "b")],
    components: [component("gate4b:cross-source", ["a", "b"])],
  });

  assert.equal(projection.collisionComponents, 1);
  assert.equal(projection.hypotheticalReduction, 1);
  assert.deepEqual(projection.collisionSamples[0]?.memberSources, [
    { providerTrackId: "a", sourcePlaylistIds: ["source-a"] },
    { providerTrackId: "b", sourcePlaylistIds: ["source-b"] },
  ]);
});

test("legacy-only and distinct recordings remain distinct", () => {
  const projection = projectGate4CUniverse({
    occurrences: [
      occurrence("source-a", "live-forever-title"),
      occurrence("source-a", "studio"),
      occurrence("source-a", "live"),
    ],
    components: [],
  });

  assert.equal(projection.safeComponentMappedTracks, 0);
  assert.equal(projection.legacyOnlyTracks, 3);
  assert.equal(projection.hypotheticalCanonicalRecordingKeys, 3);
  assert.equal(projection.hypotheticalReduction, 0);
});

test("duplicate occurrences of the same Spotify track do not invent canonical reduction", () => {
  const projection = projectGate4CUniverse({
    occurrences: [
      occurrence("source-a", "a"),
      occurrence("source-b", "a"),
      occurrence("source-b", "b"),
    ],
    components: [component("gate4b:dedupe", ["a", "b"])],
  });

  assert.equal(projection.candidateOccurrences, 3);
  assert.equal(projection.distinctProviderTrackIds, 2);
  assert.equal(projection.hypotheticalReduction, 1);
});

test("projection is deterministic regardless of occurrence ordering", () => {
  const rows = [
    occurrence("source-b", "b"),
    occurrence("source-a", "a"),
    occurrence("source-a", "legacy"),
  ];
  const components = [component("gate4b:stable", ["a", "b"])];
  const first = projectGate4CUniverse({ occurrences: rows, components });
  const second = projectGate4CUniverse({ occurrences: [...rows].reverse(), components });

  assert.equal(first.hypotheticalReduction, second.hypotheticalReduction);
  assert.deepEqual(first.collisionComponentIds, second.collisionComponentIds);
  assert.deepEqual(first.collisionSamples, second.collisionSamples);
});

test("overlapping safe components fail closed", () => {
  assert.throws(
    () =>
      projectGate4CUniverse({
        occurrences: [occurrence("source-a", "b")],
        components: [
          component("gate4b:first", ["a", "b"]),
          component("gate4b:second", ["b", "c"]),
        ],
      }),
    /unsafe overlapping component membership/,
  );
});
