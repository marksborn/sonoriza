import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { prisma } from "@/lib/prisma";
import { encodeMusicSourceCache } from "./source-cache";
import { createMusicSourceCleanupPreview, executeMusicSourceCleanupPreview, executeAutomaticMusicSourceCleanup } from "./source-cleanup";
import { resolvePersistedCleanupRecordingEvidence, loadCleanupPlaybackHistory } from "./source-cleanup-recording-runtime";

const dbTest = process.env.MUSIC02_RECORDING_DB_TEST === "1" ? test : test.skip;
const current = new Date();
const isrc = "USAAA2600001";

async function fixture(t: TestContext) {
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `cleanup-${key}@example.test` } });
  const directory = await mkdtemp(path.join(tmpdir(), "music02-recording-"));
  const before = { cache: process.env.SPOTIFY_CATALOG_CACHE_DIR, fence: process.env.AUDIOBOOK02_WRITE_FENCE_MODE };
  process.env.SPOTIFY_CATALOG_CACHE_DIR = directory;
  process.env.AUDIOBOOK02_WRITE_FENCE_MODE = "OFF";
  await prisma.account.create({ data: { userId: user.id, type: "oauth", provider: "spotify",
    providerAccountId: key, access_token: "synthetic-token", expires_at: Math.floor(Date.now() / 1000) + 3600,
    scope: "user-read-recently-played" } });
  await prisma.musicPlaybackPolicy.create({ data: { userId: user.id, enabled: true, windowValue: 6, windowUnit: "MONTHS" } });
  const source = await prisma.sourcePlaylist.create({ data: { userId: user.id, name: "Synthetic inbox",
    kind: "MUSIC", spotifyType: "PLAYLIST", spotifyId: `playlist-${key}`, enabled: true,
    musicRetentionMode: "REMOVE_AFTER_PLAYED", musicCleanupAutomationEnabled: true,
    musicCleanupFirstCompletedAt: new Date(current.getTime() - 86400000), spotifySnapshotId: "snapshot-1",
    cachedCandidates: encodeMusicSourceCache([{ type: "MUSIC", uri: "spotify:track:source-a", spotifyTrackId: "source-a",
      title: "Example Song", primaryArtistId: "artist-a", primaryArtistName: "Example Artist",
      albumId: "album-a", durationMs: 180000 }]),
  } });
  const playedAt = new Date(current.getTime() - 86400000);
  await prisma.trackListeningState.create({ data: { userId: user.id, spotifyTrackId: "heard-a", lastPlayedAt: playedAt } });
  const event = await prisma.trackListeningEvent.create({ data: { userId: user.id, spotifyTrackId: "heard-a",
    trackName: "Example Song", artistName: "Example Artist", primaryArtistId: "artist-a", isrc,
    playedAt, source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `cleanup-${key}`,
    metadata: { spotifyRecentlyPlayed: { trackDurationMs: 180000 } } } });
  const originalFetch = globalThis.fetch;
  let snapshot = "snapshot-1";
  let catalogStatus = 200;
  let catalogReads = 0;
  let writes = 0;
  let allowRemoval = false;
  let present = true;
  let afterCatalog: () => Promise<void> = async () => {};
  const track = { id: "source-a", uri: "spotify:track:source-a", type: "track", name: "Example Song",
    duration_ms: 180000, artists: [{ id: "artist-a", uri: "spotify:artist:artist-a", name: "Example Artist" }], external_ids: { isrc } };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes++;
      if (allowRemoval && method === "DELETE" && url.pathname === `/v1/playlists/${source.spotifyId}/items`) {
        present = false;
        snapshot = "snapshot-removed";
        return new Response(JSON.stringify({ snapshot_id: snapshot }), { status: 200 });
      }
      throw new Error("unexpected provider write");
    }
    let body: unknown;
    if (url.pathname === "/v1/me") body = { id: "synthetic-owner" };
    else if (url.pathname === "/v1/me/player/recently-played") body = { items: [], next: null };
    else if (url.pathname.startsWith("/v1/tracks/")) {
      catalogReads++;
      await afterCatalog();
      const requestedId = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return new Response(JSON.stringify(catalogStatus === 200 ? { ...track, id: requestedId, uri: `spotify:track:${requestedId}` } : { error: { message: "synthetic failure" } }),
        { status: catalogStatus, headers: { "Content-Type": "application/json" } });
    } else if (url.pathname.endsWith("/items")) body = { items: present ? [{ item: track, is_local: false }] : [], next: null };
    else if (url.pathname === `/v1/playlists/${source.spotifyId}`) body = { snapshot_id: snapshot, owner: { id: "synthetic-owner" } };
    else throw new Error("unexpected mocked path");
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (before.cache === undefined) delete process.env.SPOTIFY_CATALOG_CACHE_DIR; else process.env.SPOTIFY_CATALOG_CACHE_DIR = before.cache;
    if (before.fence === undefined) delete process.env.AUDIOBOOK02_WRITE_FENCE_MODE; else process.env.AUDIOBOOK02_WRITE_FENCE_MODE = before.fence;
    await prisma.user.delete({ where: { id: user.id } });
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  return { user, source, event, track, writes: () => writes, reads: () => catalogReads,
    setSnapshot: (value: string) => { snapshot = value; }, setStatus: (value: number) => { catalogStatus = value; },
    allowRemoval: () => { allowRemoval = true; }, onCatalog: (hook: () => Promise<void>) => { afterCatalog = hook; } };
}

dbTest("preview recognizes another ID by persisted recording facts, without provider mutation", async t => {
  const f = await fixture(t);
  const preview = await createMusicSourceCleanupPreview(f.user.id, f.source.id);
  assert.deepEqual(preview.removableUris, ["spotify:track:source-a"]);
  assert.equal(preview.recordingAssessments[0]?.decision, "CONFIRMED_RECORDING");
  assert.equal(f.reads(), 0, "stable playlist fields already include recording metadata");
  assert.equal(f.writes(), 0);
  assert.equal(await prisma.trackListeningState.count({ where: { userId: f.user.id, spotifyTrackId: "source-a" } }), 0);
  assert.equal(await prisma.trackProviderRef.count({ where: { userId: f.user.id } }), 0);
});

dbTest("confirmation revalidates facts and stales a withdrawn match before DELETE", async t => {
  const f = await fixture(t);
  const preview = await createMusicSourceCleanupPreview(f.user.id, f.source.id);
  await prisma.trackListeningEvent.update({ where: { id: f.event.id }, data: { isrc: "USAAA2600002" } });
  await assert.rejects(executeMusicSourceCleanupPreview(f.user.id, preview.previewId), /desatualizado/);
  assert.equal(f.writes(), 0);
  assert.equal((await prisma.musicSourceCleanupRun.findUniqueOrThrow({ where: { id: preview.previewId } })).status, "STALE");
});

dbTest("confirmation removes only the approved synthetic item and audits the result", async t => {
  const f = await fixture(t);
  const preview = await createMusicSourceCleanupPreview(f.user.id, f.source.id);
  f.allowRemoval();
  const result = await executeMusicSourceCleanupPreview(f.user.id, preview.previewId);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.removedTrackCount, 1);
  assert.equal(f.writes(), 1);
  assert.equal(await prisma.trackListeningState.count({ where: { userId: f.user.id } }), 1);
  assert.equal(await prisma.trackProviderRef.count({ where: { userId: f.user.id } }), 0);
});

dbTest("automatic cleanup uses the same confirmed recording and keeps cache continuity", async t => {
  const f = await fixture(t);
  f.allowRemoval();
  const result = await executeAutomaticMusicSourceCleanup(f.user.id, f.source.id);
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.removedTrackCount, 1);
  assert.equal(f.reads(), 1);
  assert.equal(f.writes(), 1);
  const source = await prisma.sourcePlaylist.findUniqueOrThrow({ where: { id: f.source.id } });
  assert.equal(source.spotifySnapshotId, "snapshot-removed");
  assert.equal(await prisma.trackListeningState.count({ where: { userId: f.user.id, spotifyTrackId: "source-a" } }), 0);
});

dbTest("a snapshot changed during enrichment aborts automatic cleanup before DELETE", async t => {
  const f = await fixture(t);
  f.onCatalog(async () => { f.setSnapshot("snapshot-changed"); });
  await assert.rejects(executeAutomaticMusicSourceCleanup(f.user.id, f.source.id), /mudou durante/);
  assert.equal(f.writes(), 0);
});

dbTest("revoking source retention during enrichment aborts automatic cleanup", async t => {
  const f = await fixture(t);
  f.onCatalog(async () => { await prisma.sourcePlaylist.update({ where: { id: f.source.id }, data: { musicRetentionMode: "KEEP_ALL" } }); });
  await assert.rejects(executeAutomaticMusicSourceCleanup(f.user.id, f.source.id), /autorização da fonte mudou/);
  assert.equal(f.writes(), 0);
});

dbTest("recording history cannot cross user boundaries", async t => {
  const f = await fixture(t);
  const other = await prisma.user.create({ data: { email: `other-${randomUUID()}@example.test` } });
  t.after(() => prisma.user.delete({ where: { id: other.id } }).then(() => undefined));
  const history = await loadCleanupPlaybackHistory(other.id, new Date());
  assert.equal(history.facts.length, 0);
  assert.equal(history.playedTrackIds.size, 0);
  await assert.rejects(createMusicSourceCleanupPreview(other.id, f.source.id), /não encontrada/);
  assert.equal(f.writes(), 0);
});

dbTest("automatic catalog failure aborts before all provider writes", async t => {
  const f = await fixture(t);
  f.setStatus(503);
  await assert.rejects(executeAutomaticMusicSourceCleanup(f.user.id, f.source.id));
  assert.equal(f.reads(), 1);
  assert.equal(f.writes(), 0);
});

dbTest("automatic source opt-in remains mandatory before catalog reads", async t => {
  const f = await fixture(t);
  await prisma.sourcePlaylist.update({ where: { id: f.source.id }, data: { musicRetentionMode: "KEEP_ALL" } });
  await assert.rejects(executeAutomaticMusicSourceCleanup(f.user.id, f.source.id), /não está autorizada/);
  assert.equal(f.reads(), 0);
  assert.equal(f.writes(), 0);
});

dbTest("automatic metadata enrichment has a four-request budget and records only confirmed IDs", async t => {
  const f = await fixture(t);
  const candidates = Array.from({ length: 5 }, (_, i) => ({ uri: `spotify:track:source-${i}`, aliases: [`source-${i}`],
    isTrack: true, isLocal: false, recording: { title: "Example Song", artistId: "artist-a",
      artistName: "Example Artist", durationMs: 180000, isrc: null } }));
  const result = await resolvePersistedCleanupRecordingEvidence(f.user.id, candidates, new Date());
  assert.equal(f.reads(), 4);
  assert.equal(result.assessments.filter(a => a.decision === "CONFIRMED_RECORDING").length, 4);
  assert.equal(result.assessments.filter(a => a.decision === "REVIEW_BUDGET").length, 1);
  assert.equal(f.writes(), 0);
});
