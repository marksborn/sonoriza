import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { prisma } from "@/lib/prisma";
import { spotifyRecentlyPlayedPlannerCapability } from "@/services/data-policy";
import { prepareKeepFilledTarget } from "@/services/keep-filled-maintenance";
import type { Candidate, PlanRunResult } from "@/services/playlist-planner";
import {
  prepareLastFmFactualCooldown, filterMusicCandidatesForLastFmFactualCooldown,
  revalidateMusicRepeatBeforeRealWrite, runWithMusicRepeatState,
  LastFmFactualCooldownPreWriteBlockedError, LastFmFactualCooldownPreWriteUnavailableError,
  type MusicRepeatRunState,
} from "@/jobs/music-repeat-runtime";
import { CANONICAL_COOLDOWN_APPROVAL, canonicalPreservationMismatch } from "./canonical-factual-cooldown";
import { prepareCanonicalFactualCooldown, CANONICAL_COOLDOWN_FACT_LIMIT, CANONICAL_COOLDOWN_REF_LIMIT } from "./canonical-factual-cooldown-preparation";

const databaseTest = process.env.CANONICAL_COOLDOWN_DB_TEST === "1" ? test : test.skip;
const remaster: Candidate = { type: "MUSIC", uri: "spotify:track:source-remaster", spotifyTrackId: "source-remaster",
  title: "Example Song - Remastered", primaryArtistName: "Example Artist", durationMs: 180000 };
const fresh: Candidate = { ...remaster, uri: "spotify:track:fresh", spotifyTrackId: "fresh", title: "Fresh Song" };

async function fixture(t: TestContext) {
  const userId = `canonical-test-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId } });
  t.after(async () => {
    await prisma.trackProviderRef.deleteMany({ where: { userId } });
    await prisma.recordingIdentity.deleteMany({ where: { userId } });
    await prisma.songIdentity.deleteMany({ where: { userId } });
    await prisma.artistIdentity.deleteMany({ where: { userId } });
    await prisma.user.delete({ where: { id: userId } });
  });
  const target = await prisma.targetPlaylist.create({ data: { userId, name: "Synthetic target", sequencePattern: ["MUSIC"],
    spotifyPlaylistId: "synthetic-target", durationMode: "FIXED", fixedDurationSeconds: 300, podcastPercent: 0, updatePolicy: "KEEP_FILLED" } });
  await prisma.musicPlaybackPolicy.create({ data: { userId, enabled: true, windowValue: 6, windowUnit: "MONTHS" } });
  const artist = await prisma.artistIdentity.create({ data: { userId, canonicalName: "Example Artist" } });
  const song = await prisma.songIdentity.create({ data: { userId, primaryArtistIdentityId: artist.id, canonicalTitle: "Example Song" } });
  const recording = await prisma.recordingIdentity.create({ data: { userId, songIdentityId: song.id, versionClass: "STANDARD" } });
  await prisma.trackProviderRef.createMany({ data: ["heard-original", "source-remaster"].map(providerTrackId => ({
    userId, recordingIdentityId: recording.id, provider: "spotify", providerScope: "global", providerTrackId,
    isrc: "USAAA2600001", matchReason: "SAME_RECORDING_HIGH_CONFIDENCE", confidenceBasisPoints: 9500,
    resolutionLineage: { origins: ["SPOTIFY"] },
  })) });
  const asOf = new Date();
  const cutoff = new Date(asOf); cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  await prisma.trackListeningEvent.create({ data: { userId, source: "LASTFM_SCROBBLE", sourceEventKey: "synthetic-fact",
    spotifyTrackId: "heard-original", trackName: "Example Song", artistName: "Example Artist", playedAt: new Date(asOf.getTime() - 86400000) } });
  const env = { MUSIC_REPEAT_LASTFM_MODE: "ACTIVE", MUSIC_REPEAT_LASTFM_USER_IDS: userId, LASTFM_API_KEY: "synthetic-key",
    LASTFM_USERNAME: "synthetic-user", MUSIC_REPEAT_CANONICAL_MODE: "ACTIVE", MUSIC_REPEAT_CANONICAL_ALLOWLIST: `${userId}:${target.id}`,
    MUSIC_REPEAT_CANONICAL_APPROVED_USE: CANONICAL_COOLDOWN_APPROVAL };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const originalFetch = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (input, init) => {
    if (init?.method && init.method !== "GET") { writes++; throw new Error("HTTP writes forbidden in fixture"); }
    const url = new URL(String(input));
    let body: unknown;
    if (url.hostname === "ws.audioscrobbler.com") body = { recenttracks: { track: [], "@attr": { page: "1", totalPages: "0", total: "0" } } };
    else if (url.hostname === "api.spotify.com" && url.pathname.endsWith("/items")) {
      body = { next: null, items: [remaster, fresh].map(c => ({ item: { id: c.spotifyTrackId, uri: c.uri, name: c.title,
        type: "track", duration_ms: c.durationMs, is_playable: true, artists: [{ id: "artist", name: "Example Artist" }], album: { id: "album", name: "Example Album" } } })) };
    } else if (url.hostname === "api.spotify.com" && url.pathname === "/v1/playlists/synthetic-target") body = { snapshot_id: "stable-synthetic" };
    else throw new Error(`Unexpected mocked request: ${url.hostname}${url.pathname}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(writes, 0, "No HTTP mutation may occur");
  });
  const prepare = () => prepareCanonicalFactualCooldown({ userId, targetIds: [target.id], asOf, cutoff, factualReady: true, legacyActive: true });
  const runtime = async (): Promise<MusicRepeatRunState> => ({
    userId, simulate: false, targetPlaylistIds: [target.id],
    context: { enabled: true, windowValue: 6, windowUnit: "MONTHS", cutoff, historyKnownSince: cutoff, lastSyncAt: asOf, blockedTrackIds: new Set() },
    initialSync: { enabled: true, eventsRead: 0, identitiesUpdated: 0, listeningEventsInserted: 0, listeningEventsDuplicateCount: 0,
      listeningEventsSuppressedByHandoff: 0, historyKnownSince: cutoff, lastSyncAt: asOf },
    repeatCompliance: spotifyRecentlyPlayedPlannerCapability(), recentlyPlayedSkippedCount: 0, missingTrackIdentitySkippedCount: 0,
    preWriteSync: null, preWriteRevalidated: false, preWriteBlockedCount: 0, preWriteMissingIdentityCount: 0,
    firstPartyPlaybackPreferences: [], firstPartyPreferenceEvidence: null,
    lastFmFactualCooldown: await prepareLastFmFactualCooldown(userId, new Date(), [target.id]),
  });
  const plan = (item: Candidate) => ({ targets: [{ targetPlaylistId: target.id, result: { items: [item] } }] }) as PlanRunResult;
  return { userId, target, recording, prepare, runtime, plan };
}

databaseTest("canonical DB snapshot scopes evidence and requires explicit policy approval", async t => {
  const f = await fixture(t);
  const state = await f.prepare();
  assert.equal(state.status, "READY");
  assert.equal(state.linkedFactCount, 1);
  assert.equal(state.blockedRefs.size, 2);
  delete process.env.MUSIC_REPEAT_CANONICAL_APPROVED_USE;
  assert.equal((await f.prepare()).status, "POLICY_NOT_APPROVED");
  process.env.MUSIC_REPEAT_CANONICAL_APPROVED_USE = CANONICAL_COOLDOWN_APPROVAL;
  await prisma.targetPlaylist.update({ where: { id: f.target.id }, data: { enabled: false } });
  assert.equal((await f.prepare()).status, "EVIDENCE_UNAVAILABLE");
});

databaseTest("planner filter and actual pre-write refresh veto the remaster but allow fresh music", async t => {
  const f = await fixture(t);
  const state = await f.runtime();
  assert.equal(state.lastFmFactualCooldown?.status, "READY_ACTIVE");
  assert.deepEqual(filterMusicCandidatesForLastFmFactualCooldown([remaster, fresh], state.lastFmFactualCooldown).candidates, [fresh]);
  await assert.rejects(runWithMusicRepeatState(state, () => revalidateMusicRepeatBeforeRealWrite(f.plan(remaster))), LastFmFactualCooldownPreWriteBlockedError);
  await runWithMusicRepeatState(await f.runtime(), () => revalidateMusicRepeatBeforeRealWrite(f.plan(fresh)));
});

databaseTest("revoking a persisted association or rollout aborts an already prepared real write", async t => {
  const f = await fixture(t);
  const state = await f.runtime();
  await prisma.trackProviderRef.updateMany({ where: { userId: f.userId, providerTrackId: "source-remaster" }, data: { matchReason: "SINGLETON_BOOTSTRAP" } });
  await assert.rejects(runWithMusicRepeatState(state, () => revalidateMusicRepeatBeforeRealWrite(f.plan(fresh))), LastFmFactualCooldownPreWriteUnavailableError);
  const next = await f.runtime();
  process.env.MUSIC_REPEAT_CANONICAL_MODE = "OFF";
  await assert.rejects(runWithMusicRepeatState(next, () => revalidateMusicRepeatBeforeRealWrite(f.plan(fresh))), LastFmFactualCooldownPreWriteUnavailableError);
});

databaseTest("KEEP_FILLED removes proven remasters and carries revocable preservation evidence without HTTP writes", async t => {
  const f = await fixture(t);
  await prisma.account.create({ data: { userId: f.userId, type: "oauth", provider: "spotify", providerAccountId: f.userId,
    access_token: "synthetic-token", expires_at: Math.floor(Date.now() / 1000) + 3600 } });
  const result = await prepareKeepFilledTarget(f.userId, f.target, new Date(), [], false);
  assert.deepEqual(result.patch?.removeUris, [remaster.uri]);
  assert.deepEqual(result.patch?.preservedUris, [fresh.uri]);
  assert.ok(result.patch?.canonicalCooldownEvidence);
  const evidence = [result.patch.canonicalCooldownEvidence];
  assert.equal(canonicalPreservationMismatch(evidence, await f.prepare()), false);
  await prisma.trackProviderRef.updateMany({ where: { userId: f.userId, providerTrackId: "source-remaster" }, data: { matchReason: "SINGLETON_BOOTSTRAP" } });
  assert.equal(canonicalPreservationMismatch(evidence, await f.prepare()), true);
});

databaseTest("bounded DB preparation refuses truncated factual evidence", async t => {
  const f = await fixture(t);
  const playedAt = new Date(Date.now() - 86400000);
  for (let start = 0; start < CANONICAL_COOLDOWN_FACT_LIMIT; start += 1000) {
    await prisma.trackListeningEvent.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({
      userId: f.userId, source: "LASTFM_SCROBBLE" as const, sourceEventKey: `bounded-${start + i}`,
      spotifyTrackId: "heard-original", trackName: "Example Song", artistName: "Example Artist", playedAt,
    })) });
  }
  assert.equal((await f.prepare()).status, "EVIDENCE_UNAVAILABLE");
});

databaseTest("bounded DB preparation refuses a truncated recording component", async t => {
  const f = await fixture(t);
  for (let start = 0; start < CANONICAL_COOLDOWN_REF_LIMIT; start += 1000) {
    await prisma.trackProviderRef.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({
      userId: f.userId, recordingIdentityId: f.recording.id, provider: "spotify", providerTrackId: `bounded-${start + i}`,
      isrc: "USAAA2600001", matchReason: "SAME_RECORDING_HIGH_CONFIDENCE", confidenceBasisPoints: 9500,
      resolutionLineage: { origins: ["SPOTIFY"] },
    })) });
  }
  assert.equal((await f.prepare()).status, "EVIDENCE_UNAVAILABLE");
});
