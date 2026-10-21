import assert from "node:assert/strict";
import test from "node:test";
import {
  compareGate5AFactualCooldown,
  type Gate5AFactualEvent,
  type Gate5AProviderRef,
} from "./canonical-factual-cooldown-shadow";

const heard: Gate5AFactualEvent = {
  trackName: "Ride The Lightning",
  artistName: "Metallica",
  spotifyTrackId: "old-master",
  isrc: "USABC1234567",
  trackMbid: null,
};
const candidate = {
  spotifyTrackId: "remaster",
  trackName: "Ride The Lightning - Remastered",
  artistName: "Metallica",
};
const refs: Gate5AProviderRef[] = [
  {
    providerTrackId: "old-master",
    recordingIdentityId: "recording-1",
    matchReason: "SINGLETON_BOOTSTRAP",
    confidenceBasisPoints: 5_000,
    isrc: "USABC1234567",
    trackMbid: null,
  },
  {
    providerTrackId: "remaster",
    recordingIdentityId: "recording-1",
    matchReason: "SAME_RECORDING_HIGH_CONFIDENCE",
    confidenceBasisPoints: 9_500,
    isrc: "USABC1234567",
    trackMbid: null,
  },
];

test("Gate 5A: proven original/remaster recording is an additional shadow cooldown", () => {
  const result = compareGate5AFactualCooldown({
    published: candidate,
    events: [heard],
    refs,
  });
  assert.equal(result.legacyTextMatch, false);
  assert.equal(result.canonical, "STRONG_SAME_RECORDING");
  assert.equal(result.canonicalIsAdditionalCooldown, true);
});

test("Gate 5A: same ISRC with separate recordings is only review evidence", () => {
  const result = compareGate5AFactualCooldown({
    published: candidate,
    events: [heard],
    refs: refs.map((ref) =>
      ref.providerTrackId === "old-master"
        ? { ...ref, recordingIdentityId: "recording-other" }
        : ref
    ),
  });
  assert.equal(result.canonical, "REVIEW_ISRC_OR_MBID_ONLY");
  assert.equal(result.canonicalIsAdditionalCooldown, false);
});

test("Gate 5A: singleton bootstrap is not strong recording equivalence", () => {
  const result = compareGate5AFactualCooldown({
    published: candidate,
    events: [heard],
    refs: refs.map((ref) => ({
      ...ref,
      matchReason: "SINGLETON_BOOTSTRAP",
    })),
  });
  assert.equal(result.canonical, "REVIEW_WEAK_SAME_RECORDING");
  assert.equal(result.canonicalIsAdditionalCooldown, false);
});

test("Gate 5A: live and studio have distinct recordings", () => {
  const result = compareGate5AFactualCooldown({
    published: { ...candidate, trackName: "Ride The Lightning - Live" },
    events: [heard],
    refs: refs.map((ref) =>
      ref.providerTrackId === "old-master"
        ? { ...ref, recordingIdentityId: "studio" }
        : { ...ref, recordingIdentityId: "live", isrc: "USDIFFERENT01" }
    ),
  });
  assert.equal(result.canonical, "ABSTAIN_NO_CANONICAL_EVIDENCE");
  assert.equal(result.legacyTextMatch, false);
});

test("Gate 5A: cover with different artist does not become canonical match by title", () => {
  const result = compareGate5AFactualCooldown({
    published: { spotifyTrackId: "cover", trackName: heard.trackName, artistName: "Cover Artist" },
    events: [heard],
    refs: [],
  });
  assert.equal(result.legacyTextMatch, false);
  assert.equal(result.canonical, "ABSTAIN_NO_CANONICAL_EVIDENCE");
});

test("Gate 5A: exact factual provider ID works without canonical projection", () => {
  const result = compareGate5AFactualCooldown({
    published: { ...candidate, spotifyTrackId: "old-master" },
    events: [heard],
    refs: [],
  });
  assert.equal(result.canonical, "EXACT_PROVIDER_REF");
  assert.equal(result.canonicalIsAdditionalCooldown, true);
});

test("Gate 5A: Last.fm text alone cannot manufacture provider recording identity", () => {
  const result = compareGate5AFactualCooldown({
    published: candidate,
    events: [{ ...heard, spotifyTrackId: null, isrc: null }],
    refs,
  });
  assert.equal(result.canonical, "ABSTAIN_NO_CANONICAL_EVIDENCE");
  assert.equal(result.canonicalIsAdditionalCooldown, false);
});

test("Gate 5A: exact text legacy match remains independent of canonical evidence", () => {
  const result = compareGate5AFactualCooldown({
    published: { spotifyTrackId: "new", trackName: "Dragon Fly", artistName: "Atomship" },
    events: [{ ...heard, trackName: "Dragonfly", artistName: "Atomship", spotifyTrackId: null, isrc: null }],
    refs: [],
  });
  assert.equal(result.legacyTextMatch, true);
  assert.equal(result.canonical, "ABSTAIN_NO_CANONICAL_EVIDENCE");
  assert.equal(result.canonicalIsAdditionalCooldown, false);
});
