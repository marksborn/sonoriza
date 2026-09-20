import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyCatalogTrackLookup } from "@/services/spotify/catalog-search";
import {
  analyzeGate4APair,
  classifyGate4APreferenceCompatibility,
  type Gate4ATrackPreferenceObservation,
} from "./canonical-preference-shadow";

const USER_EXCLUDED: Gate4ATrackPreferenceObservation = {
  policy: "EXCLUDED",
  source: "USER_EXPLICIT",
};
const USER_PREFERRED: Gate4ATrackPreferenceObservation = {
  policy: "PREFERRED",
  source: "USER_EXPLICIT",
};
const USER_REDUCED: Gate4ATrackPreferenceObservation = {
  policy: "REDUCED",
  source: "USER_EXPLICIT",
};

function pair(overrides: {
  leftTrackName?: string;
  rightTrackName?: string;
  leftDurationMs?: number;
  rightDurationMs?: number;
} = {}) {
  return {
    left: {
      providerTrackId: "track-a",
      recordingIdentityId: "recording-a",
      primaryArtistId: "artist-a",
      primaryArtistName: "Artist A",
      trackName: overrides.leftTrackName ?? "Song",
      albumName: "Album",
      durationMs: overrides.leftDurationMs ?? 180_000,
      versionTrait: "STANDARD" as const,
    },
    right: {
      providerTrackId: "track-b",
      recordingIdentityId: "recording-b",
      primaryArtistId: "artist-a",
      primaryArtistName: "Artist A",
      trackName: overrides.rightTrackName ?? "Song",
      albumName: "Album",
      durationMs: overrides.rightDurationMs ?? 181_000,
      versionTrait: "STANDARD" as const,
    },
  };
}

function lookup(
  requestedTrackId: string,
  options: { isrc?: string | null; durationMs?: number | null } = {},
): SpotifyCatalogTrackLookup {
  const durationMs = options.durationMs === undefined ? 180_000 : options.durationMs;
  return {
    requestedTrackId,
    track: {
      id: requestedTrackId,
      name: requestedTrackId,
      uri: `spotify:track:${requestedTrackId}`,
      spotifyUrl: null,
      isrc: options.isrc === undefined ? "USGATE4A00001" : options.isrc,
      artists: [
        {
          id: "artist-a",
          name: "Artist A",
          uri: "spotify:artist:artist-a",
          spotifyUrl: null,
        },
      ],
      albumId: null,
      albumName: null,
      durationMs: durationMs ?? 0,
      linkedFromTrackId: null,
      isPlayable: true,
      restrictionReason: null,
    },
  };
}

test("same recording with no explicit TRACK preferences is safe only for future comparison", () => {
  const result = analyzeGate4APair({
    pair: pair(),
    leftLookup: lookup("track-a", { durationMs: 180_000 }),
    rightLookup: lookup("track-b", { durationMs: 181_000 }),
    leftPreference: null,
    rightPreference: null,
  });

  assert.equal(result.identityDecision, "CANONICAL_RECORDING_CANDIDATE");
  assert.equal(result.preferenceCompatibility, "SAFE_NO_EXPLICIT_TRACK_PREFERENCE");
  assert.equal(result.activationDecision, "SAFE_FOR_FUTURE_DEDUPE_COMPARISON");
  assert.equal(result.canonicalShadow.hypotheticalRecordingCount, 1);
  assert.equal(result.canonicalShadow.representativeProviderTrackId, null);
});

test("identical native preference policy and provenance are non-conflicting", () => {
  assert.equal(
    classifyGate4APreferenceCompatibility(USER_PREFERRED, USER_PREFERRED),
    "SAFE_IDENTICAL_EXPLICIT_TRACK_PREFERENCE",
  );
});

test("unilateral EXCLUDED is a semantic blocker and is never propagated", () => {
  const result = analyzeGate4APair({
    pair: pair(),
    leftLookup: lookup("track-a"),
    rightLookup: lookup("track-b", { durationMs: 180_100 }),
    leftPreference: USER_EXCLUDED,
    rightPreference: null,
  });

  assert.equal(result.identityDecision, "CANONICAL_RECORDING_CANDIDATE");
  assert.equal(
    result.preferenceCompatibility,
    "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE",
  );
  assert.equal(result.activationDecision, "BLOCKED_PREFERENCE_SEMANTICS");
  assert.deepEqual(result.left.preference, USER_EXCLUDED);
  assert.equal(result.right.preference, null);
});

test("PREFERRED x REDUCED is a policy conflict", () => {
  assert.equal(
    classifyGate4APreferenceCompatibility(USER_PREFERRED, USER_REDUCED),
    "BLOCKED_PREFERENCE_POLICY_DIVERGENCE",
  );
});

test("same policy with different first-party provenance is fail-closed", () => {
  assert.equal(
    classifyGate4APreferenceCompatibility(
      USER_PREFERRED,
      { policy: "PREFERRED", source: "SONORIZA_INTERACTION" },
    ),
    "BLOCKED_PREFERENCE_SOURCE_DIVERGENCE",
  );
});

test("explicit NORMAL versus absence remains a semantic difference", () => {
  assert.equal(
    classifyGate4APreferenceCompatibility(
      { policy: "NORMAL", source: "USER_EXPLICIT" },
      null,
    ),
    "BLOCKED_PREFERENCE_PRESENCE_DIVERGENCE",
  );
});

test("provider duration conflict blocks canonical candidacy before preference semantics", () => {
  const result = analyzeGate4APair({
    pair: pair(),
    leftLookup: lookup("track-a", { durationMs: 180_000 }),
    rightLookup: lookup("track-b", { durationMs: 260_000 }),
    leftPreference: USER_EXCLUDED,
    rightPreference: null,
  });

  assert.equal(result.identityDecision, "BLOCKED_PROVIDER_DURATION_CONFLICT");
  assert.equal(result.preferenceCompatibility, null);
  assert.equal(result.activationDecision, "BLOCKED_IDENTITY_EVIDENCE");
  assert.equal(result.canonicalShadow.hypotheticalRecordingCount, 2);
});

test("missing provider duration blocks instead of trusting persisted zero/missing duration", () => {
  const result = analyzeGate4APair({
    pair: pair({ leftDurationMs: 0 }),
    leftLookup: lookup("track-a", { durationMs: null }),
    rightLookup: lookup("track-b", { durationMs: 181_000 }),
    leftPreference: null,
    rightPreference: null,
  });

  assert.equal(result.identityDecision, "BLOCKED_PROVIDER_DURATION_MISSING");
  assert.equal(result.activationDecision, "BLOCKED_IDENTITY_EVIDENCE");
});

test("different ISRC remains blocked even when preferences match", () => {
  const result = analyzeGate4APair({
    pair: pair(),
    leftLookup: lookup("track-a", { isrc: "USGATE4A00001" }),
    rightLookup: lookup("track-b", { isrc: "USGATE4A00002" }),
    leftPreference: USER_PREFERRED,
    rightPreference: USER_PREFERRED,
  });

  assert.equal(result.identityDecision, "BLOCKED_STRONG_ID_EVIDENCE");
  assert.equal(result.preferenceCompatibility, null);
  assert.equal(result.activationDecision, "BLOCKED_IDENTITY_EVIDENCE");
});
