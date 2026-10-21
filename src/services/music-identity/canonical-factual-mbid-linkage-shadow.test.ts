import assert from "node:assert/strict";
import test from "node:test";

import {
  compareGate5BMbidEvidence,
  normalizeGate5BMbid,
  type Gate5BCandidate,
  type Gate5BScrobble,
} from "./canonical-factual-mbid-linkage-shadow";

const MBID = "12345678-1234-4abc-8abc-123456789abc";
const candidate: Gate5BCandidate = {
  providerTrackId: "spotify-master",
  title: "Ride The Lightning - Remastered",
  artistName: "Metallica",
  recordingIdentityId: "recording-one",
  providerTrackMbid: MBID,
};
const event: Gate5BScrobble = {
  trackName: "Ride The Lightning",
  artistName: "Metallica",
  trackMbid: MBID.toUpperCase(),
};
const owners = [{ recordingIdentityId: "recording-one", trackMbid: MBID }];

function compare(
  updates: {
    candidate?: Partial<Gate5BCandidate>;
    events?: Gate5BScrobble[];
    owners?: typeof owners;
  } = {},
) {
  return compareGate5BMbidEvidence({
    candidate: { ...candidate, ...updates.candidate },
    scrobbles: updates.events ?? [event],
    mbidOwners: updates.owners ?? owners,
  });
}

test("Gate 5B: original/remaster MBID overlap is review-only, never a cooldown veto", () => {
  const result = compare();
  assert.equal(result.decision, "REVIEW_MBID_REMASTER_STANDARD");
  assert.equal(result.evidenceLevel, "REVIEW_ONLY");
  assert.equal(result.matchedScrobbleCount, 1);
  assert.equal(result.eligibleForProductiveCooldown, false);
  assert.equal(result.inferredRecordingEquivalence, false);
});

test("Gate 5B: identical version is review-only", () => {
  assert.equal(
    compare({ candidate: { title: event.trackName } }).decision,
    "REVIEW_MBID_SAME_VERSION",
  );
});

test("Gate 5B: live/studio remain distinct even with same MBID", () => {
  assert.equal(
    compare({ events: [{ ...event, trackName: "Ride The Lightning - Live" }] }).decision,
    "ABSTAIN_VERSION_CONFLICT",
  );
});

test("Gate 5B: acoustic, remix, and demo versions abstain", () => {
  for (const variant of ["Acoustic", "Remix", "Demo"]) {
    assert.equal(
      compare({ events: [{ ...event, trackName: `Ride The Lightning - ${variant}` }] }).decision,
      "ABSTAIN_VERSION_CONFLICT",
    );
  }
});

test("Gate 5B: same title by different artist is not a match (cover)", () => {
  assert.equal(
    compare({ events: [{ ...event, artistName: "A Cover Band" }] }).decision,
    "ABSTAIN_ARTIST_CONFLICT",
  );
});

test("Gate 5B: a mismatching base title is not a match", () => {
  assert.equal(
    compare({ events: [{ ...event, trackName: "One" }] }).decision,
    "ABSTAIN_TITLE_CONFLICT",
  );
});

test("Gate 5B: same MBID mapped to two persisted RecordingIdentity rows abstains", () => {
  assert.deepEqual(
    compare({ owners: [...owners, { recordingIdentityId: "recording-two", trackMbid: MBID }] }),
    {
      decision: "ABSTAIN_MBID_RECORDING_COLLISION",
      evidenceLevel: "ABSTAIN",
      matchedScrobbleCount: 1,
      matchedRecordingIdentityCount: 2,
      inferredRecordingEquivalence: false,
      eligibleForProductiveCooldown: false,
    },
  );
});

test("Gate 5B: no provider-ref inventory cannot claim a unique recording", () => {
  assert.equal(compare({ owners: [] }).decision, "ABSTAIN_MBID_RECORDING_COLLISION");
});

test("Gate 5B: missing or malformed MBIDs never produce matches", () => {
  assert.equal(normalizeGate5BMbid("not-a-uuid"), null);
  assert.equal(compare({ candidate: { providerTrackMbid: "not-a-uuid" } }).decision,
    "ABSTAIN_PROVIDER_MBID_MISSING");
  assert.equal(compare({ events: [{ ...event, trackMbid: null }] }).decision,
    "ABSTAIN_NO_SCROBBLE_MBID_MATCH");
});

test("Gate 5B: conflicts in repeated scrobbles force abstention", () => {
  assert.equal(
    compare({ events: [event, { ...event, artistName: "A Cover Band" }] }).decision,
    "ABSTAIN_ARTIST_CONFLICT",
  );
});

test("Gate 5B: 'Live Forever' is not automatically classified as a live recording", () => {
  assert.equal(
    compare({
      candidate: { title: "Live Forever" },
      events: [{ ...event, trackName: "Live Forever" }],
    }).decision,
    "REVIEW_MBID_SAME_VERSION",
  );
});

test("Gate 5B: absent artist metadata cannot authorize a match", () => {
  assert.equal(
    compare({ candidate: { artistName: null } }).decision,
    "ABSTAIN_METADATA_INCOMPLETE",
  );
});
