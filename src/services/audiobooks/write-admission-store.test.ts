import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  prismaAudiobookWriteFenceStore,
  withAudiobookOverlayBindAdmission,
} from "./write-admission-store";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

async function createFixture() {
  const suffix = randomUUID().replace(/-/g, "");
  const user = await prisma.user.create({
    data: { email: `audiobook-fence-${suffix}@example.test` },
  });
  const playlistId = `target${suffix}`;
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "Audiobook gated test",
      spotifyPlaylistId: playlistId,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      sequencePattern: ["MUSIC"],
    },
  });
  return { userId: user.id, targetPlaylistId: target.id, spotifyPlaylistId: playlistId };
}

integrationTest("#489 B.2: binding is denied during an admitted write, then allowed after definite finish", { concurrency: false }, async t => {
  const fixture = await createFixture();
  t.after(async () => { await prisma.user.delete({ where: { id: fixture.userId } }); });
  const key = { userId: fixture.userId, spotifyPlaylistId: fixture.spotifyPlaylistId };

  await prismaAudiobookWriteFenceStore.begin(key);
  await assert.rejects(
    withAudiobookOverlayBindAdmission(fixture, async tx => {
      return tx.targetAudiobookOverlay.create({
        data: {
          ...fixture,
          spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
          selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
          chapterDurationMs: 20_039,
        },
      });
    }),
    /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/,
  );
  assert.equal(await prisma.targetAudiobookOverlay.count({ where: { userId: fixture.userId } }), 0);

  await prismaAudiobookWriteFenceStore.finish(key, false);
  const overlay = await withAudiobookOverlayBindAdmission(fixture, tx => tx.targetAudiobookOverlay.create({
    data: {
      ...fixture,
      spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
      selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
      chapterDurationMs: 20_039,
    },
  }));
  assert.equal(overlay.spotifyPlaylistId, fixture.spotifyPlaylistId);
  await assert.rejects(
    prismaAudiobookWriteFenceStore.begin(key),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_PROTECTED_TARGET/,
  );
  const record = await prisma.targetAudiobookWriteFence.findUniqueOrThrow({
    where: { userId_spotifyPlaylistId: key },
  });
  assert.equal(record.activeWrites, 0, "blocked writer must rollback its lease increment");
});

integrationTest("#489 B.2: unknown provider outcome cannot be silently cleared by ending active write", { concurrency: false }, async t => {
  const fixture = await createFixture();
  t.after(async () => { await prisma.user.delete({ where: { id: fixture.userId } }); });
  const key = { userId: fixture.userId, spotifyPlaylistId: fixture.spotifyPlaylistId };
  await prismaAudiobookWriteFenceStore.begin(key);
  await prismaAudiobookWriteFenceStore.finish(key, true);
  const fence = await prisma.targetAudiobookWriteFence.findUniqueOrThrow({
    where: { userId_spotifyPlaylistId: key },
  });
  assert.equal(fence.reviewRequired, true);
  assert.equal(fence.activeWrites, 0);
  await assert.rejects(
    withAudiobookOverlayBindAdmission(fixture, async () => { throw Error("should never bind"); }),
    /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/,
  );
  await assert.rejects(
    prismaAudiobookWriteFenceStore.begin(key),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_RECONCILIATION_REQUIRED/,
  );
});

integrationTest("#489 B.2: forged user or mismatched target cannot bind", { concurrency: false }, async t => {
  const fixture = await createFixture();
  t.after(async () => { await prisma.user.delete({ where: { id: fixture.userId } }); });
  await assert.rejects(
    withAudiobookOverlayBindAdmission({
      ...fixture,
      targetPlaylistId: "wrong-target",
    }, async () => { throw Error("should not commit"); }),
    /AUDIOBOOK_BIND_BLOCKED_TARGET_OWNERSHIP_OR_IDENTITY/,
  );
  await assert.rejects(
    withAudiobookOverlayBindAdmission({
      ...fixture,
      spotifyPlaylistId: "wrongSpotifyId",
    }, async () => { throw Error("should not commit"); }),
    /AUDIOBOOK_BIND_BLOCKED_TARGET_OWNERSHIP_OR_IDENTITY/,
  );
});

test("#489 B.2: live write admission is opt-in and legacy guard stays on by default", () => {
  const client = readFileSync("src/services/spotify/client.ts", "utf8");
  assert.match(client, /process\.env\.AUDIOBOOK02_WRITE_FENCE_MODE === "ACTIVE"/);
  assert.match(client, /await assertAudiobookPlaylistMutationAllowed\(/);
  assert.match(client, /withAudiobookWriteAdmission\(/);
  assert.match(client, /prismaAudiobookWriteFenceStore/);
});

test("#489 B.2: schema guarantees per-user/playlist persistent write admission row", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  assert.match(schema, /model TargetAudiobookWriteFence \{/);
  assert.match(schema, /@@id\(\[userId, spotifyPlaylistId\]\)/);
  assert.match(schema, /activeWrites\s+Int\s+@default\(0\)/);
  assert.match(schema, /reviewRequired\s+Boolean\s+@default\(false\)/);
  const migration = readFileSync(
    "prisma/migrations/20261017100500_audiobook_write_fence_gate_b2/migration.sql", "utf8",
  );
  assert.match(migration, /CHECK \("activeWrites" >= 0\)/);
});
