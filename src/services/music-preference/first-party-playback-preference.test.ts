import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_PARTY_PREFERENCE_SOURCES,
  PLAYBACK_PREFERENCE_POLICIES,
  PLAYBACK_PREFERENCE_SUBJECT_TYPES,
  lineageForFirstPartyPreference,
  normalizeFirstPartyPreferenceSubjectKey,
  normalizeSetFirstPartyPlaybackPreferenceInput,
} from "./first-party-playback-preference";

test("Gate 4 first-party sources exclude provider-derived provenance", () => {
  assert.deepEqual(FIRST_PARTY_PREFERENCE_SOURCES, [
    "USER_EXPLICIT",
    "SONORIZA_INTERACTION",
  ]);
  assert.equal(
    (FIRST_PARTY_PREFERENCE_SOURCES as readonly string[]).includes(
      "PROVIDER_RESTRICTED",
    ),
    false,
  );
  assert.equal(
    (FIRST_PARTY_PREFERENCE_SOURCES as readonly string[]).includes("SPOTIFY"),
    false,
  );
  assert.equal(
    (FIRST_PARTY_PREFERENCE_SOURCES as readonly string[]).includes(
      "LIKED_TRACK_SYNC",
    ),
    false,
  );
});

test("explicit and Sonoriza-interaction preferences both carry FIRST_PARTY lineage", () => {
  for (const source of FIRST_PARTY_PREFERENCE_SOURCES) {
    assert.deepEqual(lineageForFirstPartyPreference(source), {
      origins: ["FIRST_PARTY"],
    });
  }
});

test("Gate 4 covers the canonical preference subjects without provider identity fields", () => {
  assert.deepEqual(PLAYBACK_PREFERENCE_SUBJECT_TYPES, [
    "TRACK",
    "ARTIST",
    "VERSION_TRAIT",
    "DISCOVERY",
    "REPEAT",
  ]);
});

test("preference policy supports positive, neutral, reduced and excluded intent", () => {
  assert.deepEqual(PLAYBACK_PREFERENCE_POLICIES, [
    "PREFERRED",
    "NORMAL",
    "REDUCED",
    "EXCLUDED",
  ]);
});

test("subject keys are normalized but remain opaque Sonoriza references", () => {
  assert.equal(
    normalizeFirstPartyPreferenceSubjectKey("  version_trait:live  "),
    "version_trait:live",
  );
  assert.throws(() => normalizeFirstPartyPreferenceSubjectKey("   "));
});

test("normalizing a preference never changes its declared first-party source", () => {
  const normalized = normalizeSetFirstPartyPlaybackPreferenceInput({
    userId: "user-1",
    subjectType: "ARTIST",
    subjectKey: "  artist:canonical:123  ",
    policy: "EXCLUDED",
    source: "USER_EXPLICIT",
  });

  assert.equal(normalized.subjectKey, "artist:canonical:123");
  assert.equal(normalized.source, "USER_EXPLICIT");
  assert.deepEqual(lineageForFirstPartyPreference(normalized.source), {
    origins: ["FIRST_PARTY"],
  });
});
