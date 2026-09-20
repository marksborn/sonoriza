import assert from "node:assert/strict";
import test from "node:test";

import type {
  Gate4APairAnalysis,
  Gate4ATrackPreferenceObservation,
} from "./canonical-preference-shadow";
import { buildGate4BComponents } from "./canonical-component-closure-shadow";

const PREFERRED: Gate4ATrackPreferenceObservation = {
  policy: "PREFERRED",
  source: "USER_EXPLICIT",
};
const EXCLUDED: Gate4ATrackPreferenceObservation = {
  policy: "EXCLUDED",
  source: "USER_EXPLICIT",
};

type PairOptions = {
  leftRecordingId?: string;
  rightRecordingId?: string;
  leftIsrc?: string | null;
  rightIsrc?: string | null;
  leftDurationMs?: number | null;
  rightDurationMs?: number | null;
  leftPreference?: Gate4ATrackPreferenceObservation | null;
  rightPreference?: Gate4ATrackPreferenceObservation | null;
  identityDecision?: Gate4APairAnalysis["identityDecision"];
  strongIdOutcome?: Gate4APairAnalysis["strongIdOutcome"];
  activationDecision?: Gate4APairAnalysis["activationDecision"];
  preferenceCompatibility?: Gate4APairAnalysis["preferenceCompatibility"];
};

function pair(
  leftId: string,
  rightId: string,
  options: PairOptions = {},
): Gate4APairAnalysis {
  const identityDecision =
    options.identityDecision ?? "CANONICAL_RECORDING_CANDIDATE";
  const activationDecision =
    options.activationDecision ??
    (identityDecision === "CANONICAL_RECORDING_CANDIDATE"
      ? "SAFE_FOR_FUTURE_DEDUPE_COMPARISON"
      : "BLOCKED_IDENTITY_EVIDENCE");
  const leftPreference = options.leftPreference ?? null;
  const rightPreference = options.rightPreference ?? null;
  const preferenceCompatibility =
    options.preferenceCompatibility ??
    (identityDecision !== "CANONICAL_RECORDING_CANDIDATE"
      ? null
      : leftPreference === null && rightPreference === null
        ? "SAFE_NO_EXPLICIT_TRACK_PREFERENCE"
        : leftPreference?.policy === rightPreference?.policy &&
            leftPreference?.source === rightPreference?.source
          ? "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE"
          : "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE");

  return {
    left: {
      providerTrackId: leftId,
      recordingIdentityId: options.leftRecordingId ?? `recording-${leftId}`,
      primaryArtistName: "Artist",
      trackName: "Song",
      isrc: options.leftIsrc === undefined ? "USGATE4B00001" : options.leftIsrc,
      providerDurationMs:
        options.leftDurationMs === undefined ? 180_000 : options.leftDurationMs,
      preference: leftPreference,
    },
    right: {
      providerTrackId: rightId,
      recordingIdentityId: options.rightRecordingId ?? `recording-${rightId}`,
      primaryArtistName: "Artist",
      trackName: "Song",
      isrc: options.rightIsrc === undefined ? "USGATE4B00001" : options.rightIsrc,
      providerDurationMs:
        options.rightDurationMs === undefined ? 181_000 : options.rightDurationMs,
      preference: rightPreference,
    },
    identityDecision,
    strongIdOutcome:
      options.strongIdOutcome ??
      (identityDecision === "CANONICAL_RECORDING_CANDIDATE"
        ? "REVIEW_RECORDING_MERGE"
        : "KEEP_RECORDINGS_SEPARATE"),
    providerDurationDeltaMs: null,
    preferenceCompatibility,
    activationDecision,
    legacy: {
      providerRepresentationCount: 2,
      providerTrackIds: [leftId, rightId],
    },
    canonicalShadow: {
      hypotheticalRecordingCount:
        identityDecision === "CANONICAL_RECORDING_CANDIDATE" ? 1 : 2,
      representativeProviderTrackId: null,
      representativeSelection: "NOT_SELECTED_IN_GATE4A",
    },
  };
}

test("three mutually safe pair candidates form one safe transitive component", () => {
  const components = buildGate4BComponents([
    pair("a", "b", { leftDurationMs: 180_000, rightDurationMs: 181_000 }),
    pair("a", "c", { leftDurationMs: 180_000, rightDurationMs: 182_000 }),
    pair("b", "c", { leftDurationMs: 181_000, rightDurationMs: 182_000 }),
  ]);

  assert.equal(components.length, 1);
  const component = components[0]!;
  assert.deepEqual(component.memberProviderTrackIds, ["a", "b", "c"]);
  assert.equal(component.internalPairCount, 3);
  assert.equal(component.expectedInternalPairCount, 3);
  assert.equal(component.candidateEdgeCount, 3);
  assert.equal(component.safeInternalPairs, 3);
  assert.equal(component.componentDecision, "SAFE_CANONICAL_COMPONENT");
  assert.equal(component.canonicalShadow.hypotheticalRecordingCount, 1);
  assert.equal(component.canonicalShadow.representativeProviderTrackId, null);
  assert.equal(component.canonicalShadow.representativeRecordingIdentityId, null);
});

test("A-B safe plus B-C safe never hides an A-C identity contradiction", () => {
  const components = buildGate4BComponents([
    pair("a", "b", { leftDurationMs: 180_000, rightDurationMs: 181_000 }),
    pair("b", "c", { leftDurationMs: 181_000, rightDurationMs: 182_000 }),
    pair("a", "c", {
      leftIsrc: "USGATE4B00001",
      rightIsrc: "USGATE4B99999",
      leftDurationMs: 180_000,
      rightDurationMs: 182_000,
      identityDecision: "BLOCKED_STRONG_ID_EVIDENCE",
      strongIdOutcome: "DIFFERENT_ISRC_REVIEW_ONLY",
      activationDecision: "BLOCKED_IDENTITY_EVIDENCE",
      preferenceCompatibility: null,
    }),
  ]);

  assert.equal(components.length, 1);
  const component = components[0]!;
  assert.equal(
    component.componentDecision,
    "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION",
  );
  assert.equal(component.candidateEdgeCount, 2);
  assert.equal(component.blockedInternalPairs, 1);
  assert.equal(component.canonicalShadow.hypotheticalRecordingCount, 3);
});

test("missing transitive pair evidence blocks instead of assuming closure", () => {
  const components = buildGate4BComponents([
    pair("a", "b", { leftDurationMs: 180_000, rightDurationMs: 181_000 }),
    pair("b", "c", { leftDurationMs: 181_000, rightDurationMs: 182_000 }),
  ]);

  assert.equal(components.length, 1);
  assert.equal(
    components[0]!.componentDecision,
    "BLOCKED_INCOMPLETE_INTERNAL_EVIDENCE",
  );
  assert.equal(components[0]!.internalPairCount, 2);
  assert.equal(components[0]!.expectedInternalPairCount, 3);
});

test("component duration envelope is validated independently of pair labels", () => {
  const components = buildGate4BComponents([
    pair("a", "b", { leftDurationMs: 180_000, rightDurationMs: 188_000 }),
    pair("a", "c", { leftDurationMs: 180_000, rightDurationMs: 196_000 }),
    pair("b", "c", { leftDurationMs: 188_000, rightDurationMs: 196_000 }),
  ]);

  assert.equal(components.length, 1);
  assert.equal(components[0]!.maxDurationDeltaMs, 16_000);
  assert.equal(components[0]!.componentDecision, "BLOCKED_DURATION_CLOSURE");
});

test("preference presence divergence blocks the whole identity component", () => {
  const components = buildGate4BComponents([
    pair("a", "b", {
      leftPreference: PREFERRED,
      rightPreference: null,
      activationDecision: "BLOCKED_PREFERENCE_SEMANTICS",
      preferenceCompatibility: "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE",
    }),
  ]);

  assert.equal(components.length, 1);
  const component = components[0]!;
  assert.equal(component.preferenceState, "PREFERENCE_PRESENCE_DIVERGENCE");
  assert.equal(component.componentDecision, "BLOCKED_PREFERENCE_SEMANTICS");
  assert.equal(component.safeInternalPairs, 0);
  assert.equal(component.blockedInternalPairs, 1);
});

test("identical explicit preference provenance remains compatible without propagation", () => {
  const components = buildGate4BComponents([
    pair("a", "b", {
      leftPreference: PREFERRED,
      rightPreference: PREFERRED,
      preferenceCompatibility: "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
    }),
  ]);

  const component = components[0]!;
  assert.equal(component.preferenceState, "IDENTICAL_EXPLICIT_TRACK_PREFERENCE");
  assert.equal(component.componentDecision, "SAFE_CANONICAL_COMPONENT");
  assert.deepEqual(component.explicitPreferencePolicies, ["PREFERRED"]);
  assert.deepEqual(component.explicitPreferenceSources, ["USER_EXPLICIT"]);
});

test("identical EXCLUDED observations are compatible but remain diagnostic only", () => {
  const components = buildGate4BComponents([
    pair("a", "b", {
      leftPreference: EXCLUDED,
      rightPreference: EXCLUDED,
      preferenceCompatibility: "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
    }),
  ]);

  const component = components[0]!;
  assert.equal(component.componentDecision, "SAFE_CANONICAL_COMPONENT");
  assert.equal(component.containsExcludedPreference, true);
  assert.equal(component.canonicalShadow.representativeProviderTrackId, null);
});

test("different ISRC inside a candidate component fails closed", () => {
  const components = buildGate4BComponents([
    pair("a", "b", {
      leftIsrc: "USGATE4B00001",
      rightIsrc: "USGATE4B00002",
    }),
  ]);

  assert.equal(
    components[0]!.componentDecision,
    "BLOCKED_INTERNAL_IDENTITY_CONTRADICTION",
  );
  assert.deepEqual(components[0]!.normalizedIsrcs, [
    "USGATE4B00001",
    "USGATE4B00002",
  ]);
});

test("missing provider duration fails closed at component level", () => {
  const components = buildGate4BComponents([
    pair("a", "b", { leftDurationMs: null, rightDurationMs: 181_000 }),
  ]);

  assert.equal(components[0]!.tracksMissingProviderDuration, 1);
  assert.equal(components[0]!.componentDecision, "BLOCKED_DURATION_CLOSURE");
});

test("blocked-only pairs do not invent canonical components", () => {
  const components = buildGate4BComponents([
    pair("a", "b", {
      identityDecision: "BLOCKED_STRONG_ID_EVIDENCE",
      strongIdOutcome: "KEEP_RECORDINGS_SEPARATE",
      activationDecision: "BLOCKED_IDENTITY_EVIDENCE",
      preferenceCompatibility: null,
    }),
  ]);
  assert.deepEqual(components, []);
});

test("component id and membership are deterministic regardless of input ordering", () => {
  const rows = [
    pair("a", "b", { leftDurationMs: 180_000, rightDurationMs: 181_000 }),
    pair("a", "c", { leftDurationMs: 180_000, rightDurationMs: 182_000 }),
    pair("b", "c", { leftDurationMs: 181_000, rightDurationMs: 182_000 }),
  ];
  const first = buildGate4BComponents(rows)[0]!;
  const second = buildGate4BComponents([...rows].reverse())[0]!;
  assert.equal(first.componentId, second.componentId);
  assert.deepEqual(first.memberProviderTrackIds, second.memberProviderTrackIds);
});
