import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import { guardedSpotifyPlaylistWrite } from "./guard-direct-spotify-write";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

async function fixture() {
  const suffix = randomUUID().replace(/-/g, "");
  const user = await prisma.user.create({
    data: { email: `audiobook-legacy-${suffix}@example.test` },
  });
  const spotifyPlaylistId = `destination${suffix}`;
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "Protected legacy destination",
      spotifyPlaylistId,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      sequencePattern: ["MUSIC"],
    },
  });
  return { userId: user.id, spotifyPlaylistId, targetPlaylistId: target.id };
}

integrationTest("#489 B.2: legacy direct writer rejects linked audiobook before sending", { concurrency: false }, async t => {
  const f = await fixture();
  t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
  await prisma.targetAudiobookOverlay.create({
    data: {
      ...f,
      spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
      selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
      chapterDurationMs: 20_039,
    },
  });
  let writes = 0;
  for (const method of ["POST", "DELETE"]) {
    await assert.rejects(
      guardedSpotifyPlaylistWrite(
        { userId: f.userId, path: `/playlists/${f.spotifyPlaylistId}/items`, method },
        async () => { writes += 1; return { ok: true }; },
      ),
      /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_PROTECTED_TARGET/,
    );
  }
  assert.equal(writes, 0);
});

integrationTest("#489 B.2: legacy direct writer can use a safe unprotected destination", { concurrency: false }, async t => {
  const f = await fixture();
  t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
  const before = process.env.AUDIOBOOK02_WRITE_FENCE_MODE;
  process.env.AUDIOBOOK02_WRITE_FENCE_MODE = "ACTIVE";
  try {
    const result = await guardedSpotifyPlaylistWrite(
      { userId: f.userId, path: `/playlists/${f.spotifyPlaylistId}/items`, method: "POST" },
      async () => "mocked-ok",
    );
    assert.equal(result, "mocked-ok");
    const fence = await prisma.targetAudiobookWriteFence.findUniqueOrThrow({
      where: { userId_spotifyPlaylistId: { userId: f.userId, spotifyPlaylistId: f.spotifyPlaylistId } },
    });
    assert.equal(fence.activeWrites, 0);
    assert.equal(fence.reviewRequired, false);
  } finally {
    if (before === undefined) delete process.env.AUDIOBOOK02_WRITE_FENCE_MODE;
    else process.env.AUDIOBOOK02_WRITE_FENCE_MODE = before;
  }
});

test("#489 B.2: ingestion POST and cleanup DELETE all use shared guard", () => {
  const ingest = readFileSync("src/services/spotify/music-ingestion.ts", "utf8");
  const cleanup = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  assert.match(ingest, /const result = await guardedSpotifyPlaylistWrite\(/);
  assert.match(ingest, /userId: this\.userId, path, method: "POST"/);
  assert.match(cleanup, /await guardedSpotifyPlaylistWrite<\{ snapshot_id\?: string \| null \}>\(/);
  assert.equal((cleanup.match(/await guardedSpotifyPlaylistWrite</g) ?? []).length, 2);
});
