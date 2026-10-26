import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalCooldown, resolveCanonicalCooldownScope, matchesCanonicalCooldown,
  canonicalSnapshotChanged, canonicalPreservationMismatch, emptyCanonicalCooldown,
  type CanonicalCooldownRef, type CanonicalCooldownFact } from "./canonical-factual-cooldown";
import { filterMusicCandidatesForLastFmFactualCooldown, mustBlockRealWriteForLastFmFactualCooldown,
  type LastFmFactualCooldownRuntimeState } from "@/jobs/music-repeat-runtime";

const now = new Date("2026-10-25T12:00:00Z");
const cutoff = new Date("2026-04-25T12:00:00Z");
const scope = { mode: "ACTIVE" as const, targetId: "target-a" };
const ref: CanonicalCooldownRef = { userId: "user-a", provider: "spotify", providerScope: "global",
  providerTrackId: "heard-original", recordingIdentityId: "recording-a", matchReason: "SAME_RECORDING_HIGH_CONFIDENCE",
  confidenceBasisPoints: 9500, isrc: "USAAA2600001", trackMbid: null,
  resolutionLineage: { origins: ["SPOTIFY"] }, versionClass: "STANDARD", canonicalTitle: "Example Song", canonicalArtist: "Example Artist" };
const remaster = { ...ref, providerTrackId: "source-remaster" };
const fact: CanonicalCooldownFact = { userId: "user-a", source: "LASTFM_SCROBBLE", spotifyTrackId: ref.providerTrackId,
  trackName: "Example Song", artistName: "Example Artist", isrc: null, trackMbid: null, playedAt: new Date("2026-09-20"), metadata: null };
const candidate = { type: "MUSIC" as const, uri: "spotify:track:source-remaster", spotifyTrackId: "source-remaster",
  title: "Example Song - Remastered", primaryArtistName: "Example Artist", durationMs: 180000 };
function build(refs: CanonicalCooldownRef[] = [ref, remaster], facts: CanonicalCooldownFact[] = [fact]) {
  return buildCanonicalCooldown({ userId: "user-a", scope, cutoff, asOf: now, refs, facts });
}
function runtime(canonical = build()): LastFmFactualCooldownRuntimeState {
  return { configuredMode: "ACTIVE", effectiveMode: "ACTIVE", status: "READY_ACTIVE", productiveInfluenceAllowed: true,
    windowValue: 6, windowUnit: "MONTHS", cutoff, asOf: now, blockedIdentityKeys: new Set(), localScrobbleCount: 1,
    providerScrobbleCount: 0, providerRequestedFrom: null, providerRequestedTo: null, providerPagesFetched: 0,
    providerTotalPages: 0, providerComplete: true, matchedCandidateCount: 0, skippedCandidateCount: 0,
    preWriteRevalidated: false, preWriteBlockedCount: 0, preWriteRevalidationCount: 0,
    preWriteBlockedTotalCount: 0, failure: null, canonical };
}

test("#512 proven original/remaster is excluded without a textual match", () => {
  const state = build();
  assert.equal(matchesCanonicalCooldown(candidate, state), true);
  assert.deepEqual(filterMusicCandidatesForLastFmFactualCooldown([candidate], runtime(state)).candidates, []);
  assert.equal(state.matchedCandidateCount, 1);
  assert.equal(state.blockedRefs.size, 2);
});
test("#512 no canonical match is created from text, ISRC or MBID without a linked fact ID", () => {
  assert.equal(build([ref, remaster], [{ ...fact, spotifyTrackId: null, isrc: ref.isrc }]).blockedRefs.size, 0);
  assert.equal(build([ref, remaster], [{ ...fact, spotifyTrackId: "missing", trackMbid: "93c8180f-f4f4-4a73-b73c-5d028ed9b80b" }]).blockedRefs.size, 0);
  assert.equal(build([ref, { ...remaster, recordingIdentityId: "different" }]).blockedRefs.has(candidate.spotifyTrackId), false);
});
test("#512 weak, singleton, unknown lineage, invalid confidence or namespace never authorizes aliases", () => {
  for (const change of [{ matchReason: "SINGLETON_BOOTSTRAP", confidenceBasisPoints: 10000 },
    { matchReason: "SAME_ISRC" }, { confidenceBasisPoints: 8999 }, { confidenceBasisPoints: 10001 },
    { confidenceBasisPoints: NaN }, { resolutionLineage: { origins: ["UNKNOWN"] } },
    { resolutionLineage: {} }, { provider: "other" }, { providerScope: "market:other" },
    { userId: "user-b" }, { versionClass: null }, { isrc: null, trackMbid: null }]) {
    assert.equal(build([ref, { ...remaster, ...change }]).blockedRefs.has(candidate.spotifyTrackId), false, JSON.stringify(change));
  }
});
test("#512 conflicts and malformed identifiers abstain even with a shared recording", () => {
  for (const change of [{ isrc: "USAAA2600002" }, { isrc: "invalid" },
    { canonicalTitle: "Other Song" }, { canonicalArtist: "Cover Artist" },
    { trackMbid: "bad" }, { versionClass: "LIVE" }]) {
    assert.equal(matchesCanonicalCooldown(candidate, build([ref, { ...remaster, ...change }])), false);
  }
  assert.throws(() => build([ref, remaster, { ...remaster, recordingIdentityId: "collision" }]), /Ambiguous/);
});
test("#512 artist, base title and performance guards cannot be bypassed by ID", () => {
  const state = build();
  for (const suffix of ["Live", "Acoustic", "Demo", "Remix", "Re-recorded"]) {
    assert.equal(matchesCanonicalCooldown({ ...candidate, title: `Example Song - ${suffix}` }, state), false);
    assert.equal(build([ref, remaster], [{ ...fact, trackName: `Example Song - ${suffix}` }]).blockedRefs.size, 0);
  }
  assert.equal(matchesCanonicalCooldown({ ...candidate, primaryArtistName: "Cover Artist" }, state), false);
  assert.equal(matchesCanonicalCooldown({ ...candidate, title: "Different Song" }, state), false);
  assert.equal(matchesCanonicalCooldown({ ...candidate, title: "ExampleSong - Remastered" }, state), false);
});
test("#512 foreign users, future/expired facts and quarantined history cannot bridge identity", () => {
  for (const change of [{ userId: "user-b" }, { source: "SPOTIFY_RECENTLY_PLAYED" },
    { playedAt: new Date("2099-01-01") }, { playedAt: new Date("2020-01-01") }, { playedAt: new Date("invalid") },
    { metadata: { spotifyExtendedHistory: null } }, { metadata: { spotifyRecentlyPlayed: {} } },
    { metadata: { origins: ["UNKNOWN"] } }, { metadata: [] }, { artistName: "Other Artist" }]) {
    assert.equal(build([ref, remaster], [{ ...fact, ...change }]).blockedRefs.size, 0, JSON.stringify(change));
  }
});
test("#512 shadow measures but does not filter; OFF retains legacy behavior", () => {
  const shadow = { ...build(), scope: { ...scope, mode: "SHADOW" as const } };
  assert.equal(filterMusicCandidatesForLastFmFactualCooldown([candidate], runtime(shadow)).candidates.length, 1);
  assert.equal(shadow.matchedCandidateCount, 1);
  assert.equal(filterMusicCandidatesForLastFmFactualCooldown([candidate], runtime(emptyCanonicalCooldown({ mode: "OFF", targetId: null }))).candidates.length, 1);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(runtime(emptyCanonicalCooldown(scope, "EVIDENCE_UNAVAILABLE")), false), true);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(runtime(emptyCanonicalCooldown(scope, "EVIDENCE_UNAVAILABLE")), true), false);
});
test("#512 graph/fact drift and mode changes invalidate a pending write and preservation", () => {
  const first = build();
  assert.equal(canonicalSnapshotChanged(first, build([remaster, ref])), false);
  assert.equal(canonicalSnapshotChanged(first, build([ref, { ...remaster, matchReason: "SINGLETON_BOOTSTRAP" }])), true);
  assert.equal(canonicalSnapshotChanged(first, build([ref, remaster], [{ ...fact, metadata: { spotifyRecentlyPlayed: null } }])), true);
  assert.equal(canonicalSnapshotChanged(first, undefined), true);
  assert.equal(canonicalSnapshotChanged(undefined, first), true);
  assert.equal(canonicalPreservationMismatch([{ targetId: scope.targetId, fingerprint: first.graphFingerprint! }], first), false);
  assert.equal(canonicalPreservationMismatch([{ targetId: "other-target", fingerprint: first.graphFingerprint! }], first), true);
  assert.equal(canonicalPreservationMismatch([{ targetId: scope.targetId, fingerprint: "stale" }], first), true);
});
test("#512 exact pair rollout cannot be bypassed by an unscoped or multi-target run", () => {
  const input = { userId: "user-a", mode: "ACTIVE", allowlist: "user-a:target-a,user-b:target-b" };
  assert.equal(resolveCanonicalCooldownScope({ ...input, targetIds: ["target-a"] }).mode, "ACTIVE");
  assert.equal(resolveCanonicalCooldownScope({ ...input, targetIds: ["target-b"] }).mode, "OFF");
  assert.deepEqual(resolveCanonicalCooldownScope(input), { mode: "ACTIVE", targetId: null });
  assert.deepEqual(resolveCanonicalCooldownScope({ ...input, targetIds: [] }), { mode: "ACTIVE", targetId: null });
  assert.deepEqual(resolveCanonicalCooldownScope({ ...input, targetIds: ["target-a", "target-b"] }), { mode: "ACTIVE", targetId: null });
  assert.equal(resolveCanonicalCooldownScope({ ...input, userId: "user-c" }).mode, "OFF");
});
