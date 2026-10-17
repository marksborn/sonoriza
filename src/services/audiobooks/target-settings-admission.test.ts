import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import {
  withAudiobookOverlayBindAdmission,
  withAudiobookTargetSettingsAdmission,
} from "./write-admission-store";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;
const PLAYLIST_ID = "4kYizEAtQhFsrrwD3tFphP";
const NEW_PLAYLIST_ID = "5kYizEAtQhFsrrwD3tFphP";
const BOOK_ID = "5E76EUAq7or1ncd4QNyHjI";
const CHAPTER_ID = "71PKNrJrxgaYwUY6srGQ3L";

async function fixture() {
  const suffix = randomUUID().replace(/-/g, "");
  const user = await prisma.user.create({
    data: { email: `gate-d2-${suffix}@example.test` },
  });
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "D.2 target",
      spotifyPlaylistId: PLAYLIST_ID,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      sequencePattern: ["MUSIC"],
    },
  });
  const cleanup = async () => prisma.user.delete({ where: { id: user.id } }).then(() => {});
  return { userId: user.id, targetId: target.id, cleanup };
}
function configInput(f: { userId: string; targetId: string }) {
  return {
    userId: f.userId,
    targetPlaylistId: f.targetId,
    expectedSpotifyPlaylistId: PLAYLIST_ID,
  };
}
async function attachOverlay(f: { userId: string; targetId: string }) {
  return prisma.targetAudiobookOverlay.create({
    data: {
      userId: f.userId,
      targetPlaylistId: f.targetId,
      spotifyPlaylistId: PLAYLIST_ID,
      spotifyAudiobookId: BOOK_ID,
      selectedChapterId: CHAPTER_ID,
      chapterDurationMs: 20_039,
      selectionMode: "FULL_CHAPTER",
    },
  });
}

integrationTest("#489 D.2: valid unbound target can be edited under fence",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(f.cleanup);
    await withAudiobookTargetSettingsAdmission(configInput(f), async tx => {
      const result = await tx.targetPlaylist.update({
        where: { id: f.targetId },
        data: { name: "Safe edit before binding", fixedDurationSeconds: 301 },
      });
      assert.equal(result.name, "Safe edit before binding");
    });
    const target = await prisma.targetPlaylist.findUniqueOrThrow({ where: { id: f.targetId } });
    assert.equal(target.fixedDurationSeconds, 301);
  },
);

integrationTest("#489 D.2: every config mutation of a linked destination fails closed",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(f.cleanup);
    await attachOverlay(f);
    for (const data of [
      { name: "renamed" },
      { spotifyPlaylistId: NEW_PLAYLIST_ID },
      { fixedDurationSeconds: 900 },
      { durationMode: "CALENDAR" as const, fixedDurationSeconds: null },
      { updatePolicy: "KEEP_FILLED" as const },
    ]) {
      await assert.rejects(
        withAudiobookTargetSettingsAdmission(configInput(f),
          tx => tx.targetPlaylist.update({ where: { id: f.targetId }, data })),
        /AUDIOBOOK_TARGET_CONFIG_BLOCKED_PROTECTED_OVERLAY/,
      );
    }
    const saved = await prisma.targetPlaylist.findUniqueOrThrow({ where: { id: f.targetId } });
    assert.equal(saved.spotifyPlaylistId, PLAYLIST_ID);
    assert.equal(saved.fixedDurationSeconds, 300);
    assert.equal(saved.durationMode, "FIXED");
    assert.equal(saved.name, "D.2 target");
    assert.equal(saved.updatePolicy, "MANUAL");
  },
);

integrationTest("#489 D.2: in-flight or uncertain Spotify writes disallow configuration edits",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(f.cleanup);
    const key = { userId: f.userId, spotifyPlaylistId: PLAYLIST_ID };
    await prisma.targetAudiobookWriteFence.create({
      data: { ...key, activeWrites: 1 },
    });
    await assert.rejects(
      withAudiobookTargetSettingsAdmission(configInput(f),
        tx => tx.targetPlaylist.update({ where: { id: f.targetId }, data: { name: "bad" } })),
      /AUDIOBOOK_TARGET_CONFIG_BLOCKED_REMOTE_WRITE_UNCERTAIN/,
    );
    await prisma.targetAudiobookWriteFence.update({
      where: { userId_spotifyPlaylistId: key },
      data: { activeWrites: 0, reviewRequired: true },
    });
    await assert.rejects(
      withAudiobookTargetSettingsAdmission(configInput(f),
        tx => tx.targetPlaylist.update({ where: { id: f.targetId }, data: { name: "bad" } })),
      /AUDIOBOOK_TARGET_CONFIG_BLOCKED_REMOTE_WRITE_UNCERTAIN/,
    );
  },
);

integrationTest("#489 D.2: stale destination or forged owner cannot update",
  { concurrency: false }, async t => {
    const f = await fixture();
    const other = await fixture();
    t.after(f.cleanup);
    t.after(other.cleanup);
    for (const input of [
      { ...configInput(f), userId: other.userId },
      { ...configInput(f), expectedSpotifyPlaylistId: NEW_PLAYLIST_ID },
    ]) {
      await assert.rejects(
        withAudiobookTargetSettingsAdmission(input,
          tx => tx.targetPlaylist.update({ where: { id: f.targetId }, data: { name: "bad" } })),
        /AUDIOBOOK_TARGET_CONFIG_BLOCKED_STALE_OR_FOREIGN_TARGET/,
      );
    }
  },
);

integrationTest("#489 D.2: concurrent binding and settings write serialize on shared fence",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(f.cleanup);
    let releaseEdit!: () => void;
    let entered!: () => void;
    const editEntered = new Promise<void>(resolve => { entered = resolve; });
    const editRelease = new Promise<void>(resolve => { releaseEdit = resolve; });
    const edit = withAudiobookTargetSettingsAdmission(configInput(f), async tx => {
      entered();
      await editRelease;
      await tx.targetPlaylist.update({
        where: { id: f.targetId },
        data: { spotifyPlaylistId: NEW_PLAYLIST_ID },
      });
    });
    await editEntered;
    const binding = withAudiobookOverlayBindAdmission({
      userId: f.userId, targetPlaylistId: f.targetId, spotifyPlaylistId: PLAYLIST_ID,
    }, async tx => tx.targetAudiobookOverlay.create({
      data: {
        userId: f.userId,
        targetPlaylistId: f.targetId,
        spotifyPlaylistId: PLAYLIST_ID,
        spotifyAudiobookId: BOOK_ID,
        selectedChapterId: CHAPTER_ID,
        chapterDurationMs: 20_039,
      },
    }));
    releaseEdit();
    await edit;
    await assert.rejects(binding, /AUDIOBOOK_BIND_BLOCKED_TARGET_OWNERSHIP_OR_IDENTITY/);
    const actual = await prisma.targetPlaylist.findUniqueOrThrow({ where: { id: f.targetId } });
    assert.equal(actual.spotifyPlaylistId, NEW_PLAYLIST_ID);
    assert.equal(await prisma.targetAudiobookOverlay.count({
      where: { userId: f.userId, targetPlaylistId: f.targetId },
    }), 0);
  },
);

integrationTest("#489 D.2: binding established first forces settings edit to abort",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(f.cleanup);
    await withAudiobookOverlayBindAdmission({
      userId: f.userId, targetPlaylistId: f.targetId, spotifyPlaylistId: PLAYLIST_ID,
    }, async tx => tx.targetAudiobookOverlay.create({
      data: {
        userId: f.userId,
        targetPlaylistId: f.targetId,
        spotifyPlaylistId: PLAYLIST_ID,
        spotifyAudiobookId: BOOK_ID,
        selectedChapterId: CHAPTER_ID,
        chapterDurationMs: 20_039,
      },
    }));
    await assert.rejects(
      withAudiobookTargetSettingsAdmission(configInput(f),
        tx => tx.targetPlaylist.update({ where: { id: f.targetId }, data: { name: "bad" } })),
      /AUDIOBOOK_TARGET_CONFIG_BLOCKED_PROTECTED_OVERLAY/,
    );
  },
);

test("#489 D.2: all main configuration write paths are fenced", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync("src/app/dashboard/configuracao/destinos/page.tsx", "utf8");
  const discovery = readFileSync(
    "src/app/dashboard/configuracao/destinos/discovery-actions.ts", "utf8",
  );
  assert.match(page, /withAudiobookTargetSettingsAdmission/);
  assert.match(page, /existingTarget\?\.audiobookOverlay/);
  assert.match(page, /audiobook-protected/);
  assert.match(discovery, /withAudiobookTargetSettingsAdmission/);
});
