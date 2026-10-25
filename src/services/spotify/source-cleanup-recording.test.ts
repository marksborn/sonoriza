import assert from "node:assert/strict";
import test from "node:test";
import { assessCleanupRecording, resolveCleanupRecordingEvidence,
  type CleanupPlaybackFact, type CleanupRecordingMetadata, type CleanupRecordingCandidate } from "./source-cleanup-recording";

const now = new Date("2026-10-25T12:00:00Z");
const metadata: CleanupRecordingMetadata = {
  title: "Example Song", artistId: "artist-a", artistName: "Example Artist",
  durationMs: 180000, isrc: "USAAA2600001",
};
const fact: CleanupPlaybackFact = {
  ...metadata, userId: "user-a", spotifyTrackId: "heard-a",
  source: "SPOTIFY_RECENTLY_PLAYED", playedAt: new Date("2026-09-01T12:00:00Z"),
};
const candidate: CleanupRecordingCandidate = {
  uri: "spotify:track:source-a", aliases: ["source-a"], isTrack: true, isLocal: false,
  recording: metadata,
};
function assess(update: Partial<CleanupRecordingMetadata> = {}, facts: CleanupPlaybackFact[] = [fact]) {
  return assessCleanupRecording("user-a", { ...metadata, ...update }, facts, now);
}
function resolve(update: Partial<Parameters<typeof resolveCleanupRecordingEvidence>[0]> = {}) {
  return resolveCleanupRecordingEvidence({ userId: "user-a", candidates: [candidate],
    playedTrackIds: new Set(), facts: [fact], now, ...update });
}

test("different IDs require the full recording evidence and only authorize the source occurrence", async () => {
  assert.equal(assess().decision, "CONFIRMED_RECORDING");
  const result = await resolve();
  assert.deepEqual([...result.playedTrackIds], ["source-a"]);
  assert.deepEqual(result.assessments, [{ uri: candidate.uri, decision: "CONFIRMED_RECORDING", evidenceTrackIds: ["heard-a"] }]);
  assert.equal(result.playedTrackIds.has("heard-a"), false);
});

test("ISRC or text alone never proves a removable recording", async () => {
  for (const update of [{ isrc: null }, { isrc: "bad" }, { artistId: null },
    { artistName: null }, { title: "" }, { durationMs: null },
    { durationMs: 0 }, { durationMs: NaN }, { durationMs: Infinity }]) {
    assert.equal(assess(update).decision, "ABSTAIN_METADATA");
  }
  assert.equal(assess({ isrc: "USAAA2600002" }).decision, "ABSTAIN_NO_FACT");
  assert.equal((await resolve({ facts: [{ ...fact, isrc: null }] })).playedTrackIds.size, 0);
});

test("same ISRC cannot hide cover, artist ID/name, title or duration conflicts", () => {
  for (const update of [{ artistId: "other-artist" }, { artistName: "Other Artist" },
    { title: "Other Song" }, { durationMs: 181001 }]) {
    assert.equal(assess(update).decision, "ABSTAIN_CONFLICT");
  }
  assert.equal(assess({ durationMs: 181000 }).decision, "CONFIRMED_RECORDING");
  assert.equal(assess({}, [fact, { ...fact, artistId: "cover-artist" }]).decision, "ABSTAIN_CONFLICT");
  assert.equal(assess({}, [fact, { ...fact, durationMs: null }]).decision, "ABSTAIN_METADATA");
});

test("spacing aliases remain REVIEW despite equal ISRC, artist and duration", async () => {
  const result = await resolve({ candidates: [{ ...candidate, recording: { ...metadata, title: "ExampleSong" } }] });
  assert.equal(result.assessments[0]?.decision, "REVIEW_TEXTUAL_ALIAS");
  assert.equal(result.playedTrackIds.size, 0);
});

test("standard/remaster and distinct performance classes remain REVIEW", () => {
  for (const label of ["Remastered", "Live", "Acoustic", "Demo", "Remix"]) {
    assert.equal(assess({ title: `Example Song - ${label}` }).decision, "REVIEW_VERSION");
  }
  assert.equal(assess({ title: "Example Song - Live at Venue A" }, [{ ...fact, title: "Example Song - Live at Venue B" }]).decision, "REVIEW_VERSION");
  assert.equal(assess({ title: "Live Forever" }, [{ ...fact, title: "Live Forever" }]).decision, "CONFIRMED_RECORDING");
});

test("typographic apostrophes normalize without promoting MBID or textual-only evidence", () => {
  assert.equal(assess({ title: "Example’s Song" }, [{ ...fact, title: "Example's Song" }]).decision, "CONFIRMED_RECORDING");
  assert.equal(assess({ title: "Example’s Song", isrc: null }, [{ ...fact, title: "Example's Song" }]).decision, "ABSTAIN_METADATA");
});

test("foreign users, Last.fm-only IDs, future and malformed timestamps cannot authorize removal", async () => {
  for (const update of [{ userId: "user-b" }, { source: "LASTFM_SCROBBLE" },
    { spotifyTrackId: null }, { playedAt: new Date("2099-01-01") }, { playedAt: new Date("invalid") }]) {
    const result = await resolve({ facts: [{ ...fact, ...update }] });
    assert.equal(result.playedTrackIds.size, 0);
  }
});

test("local, episode, missing-ID and unknown-URI items are never enriched", async () => {
  let calls = 0;
  const result = await resolve({ candidates: [
    { ...candidate, isLocal: true }, { ...candidate, isTrack: false },
    { ...candidate, aliases: [] }, { ...candidate, uri: null },
  ], lookup: async () => { calls++; return metadata; } });
  assert.equal(calls, 0);
  assert.equal(result.playedTrackIds.size, 0);
});

test("legacy exact IDs require no enrichment and retain their original decision", async () => {
  let calls = 0;
  const result = await resolve({ playedTrackIds: new Set(["source-a"]), facts: [],
    lookup: async () => { calls++; throw new Error("must not call catalog"); } });
  assert.equal(calls, 0);
  assert.deepEqual([...result.playedTrackIds], ["source-a"]);
});

test("cached metadata may be enriched but a changed catalog identity fails closed", async () => {
  const candidates = [{ ...candidate, recording: { ...metadata, isrc: null } }];
  const good = await resolve({ candidates, lookup: async () => metadata });
  assert.equal(good.playedTrackIds.has("source-a"), true);
  for (const update of [{ artistId: "other" }, { title: "Other Song" }, { durationMs: 190000 }]) {
    const result = await resolve({ candidates, lookup: async () => ({ ...metadata, ...update }) });
    assert.equal(result.playedTrackIds.size, 0);
    assert.equal(result.assessments[0]?.decision, "ABSTAIN_CONFLICT");
  }
});

test("budget exhaustion retains unresolved items; provider failure aborts preparation", async () => {
  const candidates = [{ ...candidate, recording: { ...metadata, isrc: null } }];
  const bounded = await resolve({ candidates, lookup: async () => "BUDGET" });
  assert.equal(bounded.assessments[0]?.decision, "REVIEW_BUDGET");
  assert.equal(bounded.playedTrackIds.size, 0);
  await assert.rejects(resolve({ candidates, lookup: async () => { throw new Error("quota unavailable"); } }), /quota unavailable/);
});

test("duplicates reuse one assessment and catalog candidate count is bounded", async () => {
  let calls = 0;
  const missing = { ...candidate, recording: { ...metadata, isrc: null } };
  const duplicate = await resolve({ candidates: [missing, missing], lookup: async () => { calls++; return metadata; } });
  assert.equal(calls, 1);
  assert.equal(duplicate.assessments.length, 1);
  calls = 0;
  const many = Array.from({ length: 101 }, (_, i) => ({ ...missing, uri: `spotify:track:${i}`, aliases: [`source-${i}`] }));
  const bounded = await resolve({ candidates: many, lookup: async () => { calls++; return null; } });
  assert.equal(calls, 100);
  assert.equal(bounded.assessments.at(-1)?.decision, "REVIEW_BUDGET");
});
