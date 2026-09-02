import assert from "node:assert/strict";
import test from "node:test";

import {
  FirstPartyPreferenceSource,
  PlaybackPreferencePolicy,
  PlaybackPreferenceSubjectType,
} from "@prisma/client";

import {
  FIRST_PARTY_PREFERENCE_SOURCES,
  PLAYBACK_PREFERENCE_POLICIES,
  PLAYBACK_PREFERENCE_SUBJECT_TYPES,
} from "./first-party-playback-preference";

test("Prisma first-party source enum cannot drift from the Gate 4 domain", () => {
  assert.deepEqual(
    Object.values(FirstPartyPreferenceSource),
    [...FIRST_PARTY_PREFERENCE_SOURCES],
  );
});

test("Prisma playback preference subject enum cannot drift from the Gate 4 domain", () => {
  assert.deepEqual(
    Object.values(PlaybackPreferenceSubjectType),
    [...PLAYBACK_PREFERENCE_SUBJECT_TYPES],
  );
});

test("Prisma playback preference policy enum cannot drift from the Gate 4 domain", () => {
  assert.deepEqual(
    Object.values(PlaybackPreferencePolicy),
    [...PLAYBACK_PREFERENCE_POLICIES],
  );
});
