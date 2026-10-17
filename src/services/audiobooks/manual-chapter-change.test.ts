import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  previewManualChapterChange,
  updateManualChapter,
} from "./manual-chapter-change";

const bookId = "5E76EUAq7or1ncd4QNyHjI";
const originalChapterId = "71PKNrJrxgaYwUY6srGQ3L";
const nextChapterId = "51PKNrJrxgaYwUY6srGQ3L";
const integrationTest = process.env.DATABASE_URL ? test : test.skip;

async function fixture() {
  const suffix = randomUUID().replace(/-/g, "");
  const user = await prisma.user.create({
    data: { email: `audiobook-gate-c-${suffix}@example.test` },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      provider: "spotify",
      type: "oauth",
      providerAccountId: `spotify-${suffix}`,
      access_token: "offline-catalogue-mock",
      expires_at: Math.floor(Date.now() / 1000) + 7200,
    },
  });
  const spotifyPlaylistId = "4kYizEAtQhFsrrwD3tFphP";
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "Audiobook change test",
      spotifyPlaylistId,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      sequencePattern: ["MUSIC"],
    },
  });
  const overlay = await prisma.targetAudiobookOverlay.create({
    data: {
      userId: user.id,
      targetPlaylistId: target.id,
      spotifyPlaylistId,
      spotifyAudiobookId: bookId,
      selectedChapterId: originalChapterId,
      chapterDurationMs: 20_039,
      manualConsumedMs: 0,
      selectionMode: "FULL_CHAPTER",
    },
  });
  return {
    userId: user.id,
    targetPlaylistId: target.id,
    overlayId: overlay.id,
    spotifyPlaylistId,
  };
}

function mockSpotify(options?: { wrongBook?: boolean; duration?: number; unavailable?: boolean }) {
  const oldFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.method ?? "GET", "GET", "NEVER write to Spotify");
    const path = String(url);
    if (path.endsWith(`/audiobooks/${bookId}`)) {
      return Response.json({ id: bookId, type: "audiobook", name: "1984" });
    }
    if (path.endsWith(`/chapters/${nextChapterId}`) ||
        path.endsWith(`/chapters/${originalChapterId}`)) {
      const requestedChapter = path.endsWith(nextChapterId) ? nextChapterId : originalChapterId;
      return Response.json({
        id: requestedChapter,
        name: requestedChapter === nextChapterId ? "Capítulo 2" : "Apresentação",
        type: "episode",
        audiobook: { id: options?.wrongBook ? "anotherBook" : bookId, type: "audiobook" },
        duration_ms: options?.duration ?? 18_000,
        is_playable: options?.unavailable ? false : true,
      });
    }
    throw Error("Unexpected external network access: " + path);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = oldFetch; } };
}

function change(targetPlaylistId: string, expectedRevision = 0,
                selectedChapterId = nextChapterId,
                selection: { mode: "FULL_CHAPTER" } |
                  { mode: "MANUAL_REMAINDER"; consumedMs: number } = { mode: "FULL_CHAPTER" }) {
  return { targetPlaylistId, expectedRevision, selectedChapterId, selection };
}

integrationTest("#489 Gate C: local chapter update increments revision and writes single audit, no Spotify writes",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
    const mock = mockSpotify();
    try {
      const request = change(f.targetPlaylistId);
      const preview = await previewManualChapterChange(f.userId, request);
      assert.equal(preview.status, "READY");
      assert.equal(preview.previousChapterId, originalChapterId);
      assert.equal(preview.selectedChapterId, nextChapterId);
      assert.equal(preview.effectivePlanningDurationMs, 18_000);
      assert.equal(preview.remainingPlanningDurationMs, 282_000);
      assert.equal(await prisma.targetAudiobookChapterChange.count({ where: { userId: f.userId } }), 0);
      const result = await updateManualChapter(f.userId, request);
      assert.equal(result.status, "UPDATED_LOCAL_ONLY");
      assert.equal(result.revision, 1);
      const saved = await prisma.targetAudiobookOverlay.findUniqueOrThrow({ where: { id: f.overlayId } });
      assert.equal(saved.revision, 1);
      assert.equal(saved.selectedChapterId, nextChapterId);
      assert.equal(saved.spotifyAudiobookId, bookId);
      assert.equal(saved.spotifyPlaylistId, f.spotifyPlaylistId);
      const history = await prisma.targetAudiobookChapterChange.findMany({ where: { overlayId: f.overlayId } });
      assert.equal(history.length, 1);
      assert.equal(history[0]?.previousChapterId, originalChapterId);
      assert.equal(history[0]?.selectedChapterId, nextChapterId);
      assert.equal(history[0]?.previousRevision, 0);
      assert.equal(history[0]?.revision, 1);
      assert.equal(mock.calls.length, 4, "Preview + update each read exact audiobook and chapter");
      await assert.rejects(updateManualChapter(f.userId, request),
        /AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_STALE_REVISION/);
      assert.equal(await prisma.targetAudiobookChapterChange.count({ where: { overlayId: f.overlayId } }), 1);
    } finally { mock.restore(); }
  },
);

integrationTest("#489 Gate C: declared remaining progress is local, revisioned and audited",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
    const mock = mockSpotify();
    try {
      const result = await updateManualChapter(f.userId, change(
        f.targetPlaylistId, 0, nextChapterId,
        { mode: "MANUAL_REMAINDER", consumedMs: 5_000 },
      ));
      assert.equal(result.effectivePlanningDurationMs, 13_000);
      assert.equal(result.remainingPlanningDurationMs, 287_000);
      const saved = await prisma.targetAudiobookOverlay.findUniqueOrThrow({ where: { id: f.overlayId } });
      assert.equal(saved.manualConsumedMs, 5_000);
      assert.equal(saved.selectionMode, "MANUAL_REMAINDER");
      const history = await prisma.targetAudiobookChapterChange.findFirstOrThrow({
        where: { overlayId: f.overlayId },
      });
      assert.equal(history.manualConsumedMs, 5_000);
    } finally { mock.restore(); }
  },
);

integrationTest("#489 Gate C: foreign owner, unchanged selection and unknown chapter membership fail closed",
  { concurrency: false }, async t => {
    const f = await fixture();
    const stranger = await fixture();
    t.after(async () => {
      await prisma.user.delete({ where: { id: f.userId } });
      await prisma.user.delete({ where: { id: stranger.userId } });
    });
    const mock = mockSpotify();
    try {
      await assert.rejects(previewManualChapterChange(stranger.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_NOT_FOUND/);
      await assert.rejects(updateManualChapter(f.userId,
        change(f.targetPlaylistId, 0, originalChapterId)),
      /AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_NO_CHANGE/);
    } finally { mock.restore(); }
    const invalid = mockSpotify({ wrongBook: true });
    try {
      await assert.rejects(updateManualChapter(f.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER/);
    } finally { invalid.restore(); }
    assert.equal(await prisma.targetAudiobookChapterChange.count({ where: { overlayId: f.overlayId } }), 0);
  },
);

integrationTest("#489 Gate C: in-flight or ambiguous provider writes block chapter updates",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
    const key = { userId: f.userId, spotifyPlaylistId: f.spotifyPlaylistId };
    await prisma.targetAudiobookWriteFence.create({
      data: { ...key, activeWrites: 1 },
    });
    const mock = mockSpotify();
    try {
      await assert.rejects(updateManualChapter(f.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/);
      await prisma.targetAudiobookWriteFence.update({ where: { userId_spotifyPlaylistId: key },
        data: { activeWrites: 0, reviewRequired: true } });
      await assert.rejects(updateManualChapter(f.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/);
    } finally { mock.restore(); }
    assert.equal(await prisma.targetAudiobookChapterChange.count({ where: { overlayId: f.overlayId } }), 0);
  },
);

integrationTest("#489 Gate C: overlong, unavailable or completely consumed chapters never update",
  { concurrency: false }, async t => {
    const f = await fixture();
    t.after(async () => { await prisma.user.delete({ where: { id: f.userId } }); });
    const large = mockSpotify({ duration: 450_000 });
    try {
      await assert.rejects(updateManualChapter(f.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_DURATION_CHAPTER_EXCEEDS_TARGET/);
    } finally { large.restore(); }
    const noPlay = mockSpotify({ unavailable: true });
    try {
      await assert.rejects(updateManualChapter(f.userId, change(f.targetPlaylistId)),
        /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER/);
    } finally { noPlay.restore(); }
    const consumed = mockSpotify();
    try {
      await assert.rejects(updateManualChapter(f.userId, change(
        f.targetPlaylistId, 0, nextChapterId,
        { mode: "MANUAL_REMAINDER", consumedMs: 18_000 },
      )), /AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_DURATION_CHAPTER_ALREADY_FINISHED/);
    } finally { consumed.restore(); }
    const saved = await prisma.targetAudiobookOverlay.findUniqueOrThrow({ where: { id: f.overlayId } });
    assert.equal(saved.revision, 0);
    assert.equal(saved.selectedChapterId, originalChapterId);
  },
);
