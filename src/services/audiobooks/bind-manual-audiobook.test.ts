import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import { bindManualAudiobook } from "./bind-manual-audiobook";
import {
  AUDIOBOOK_BIND_CONFIRMATION,
  type ManualAudiobookBindRequest,
} from "./manual-bind-contract";
import { prismaAudiobookWriteFenceStore } from "./write-admission-store";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;
const bookId = "5E76EUAq7or1ncd4QNyHjI";
const chapterId = "71PKNrJrxgaYwUY6srGQ3L";
const input: ManualAudiobookBindRequest = {
  targetPlaylistId: "placeholder",
  spotifyAudiobookId: bookId,
  selectedChapterId: chapterId,
  confirmation: AUDIOBOOK_BIND_CONFIRMATION,
  selection: { mode: "FULL_CHAPTER" },
};

async function fixture() {
  const suffix = randomUUID().replace(/-/g, "");
  const user = await prisma.user.create({
    data: { email: `audiobook-bind-${suffix}@example.test` },
  });
  await prisma.account.create({
    data: {
      userId: user.id,
      provider: "spotify",
      type: "oauth",
      providerAccountId: `spotify-${suffix}`,
      access_token: "mocked-audiobook-readonly-token",
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      scope: "user-read-private",
    },
  });
  const spotifyPlaylistId = "4kYizEAtQhFsrrwD3tFphP";
  const target = await prisma.targetPlaylist.create({
    data: {
      userId: user.id,
      name: "Audiobook test target",
      spotifyPlaylistId,
      sequencePattern: ["MUSIC"],
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
    },
  });
  return { userId: user.id, targetPlaylistId: target.id, spotifyPlaylistId };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function fakeSpotifyChapter(
  overrides: { audiobookId?: string; durationMs?: number; playable?: boolean } = {},
) {
  const before = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    paths.push(url);
    if (url.endsWith(`/audiobooks/${bookId}`)) {
      return json({ id: bookId, type: "audiobook", name: "1984" });
    }
    if (url.endsWith(`/chapters/${chapterId}`)) {
      return json({
        id: chapterId,
        type: "episode",
        name: "Apresentação",
        duration_ms: overrides.durationMs ?? 20_039,
        is_playable: overrides.playable ?? true,
        audiobook: { id: overrides.audiobookId ?? bookId, type: "audiobook" },
      });
    }
    throw Error(`Unexpected Spotify GET: ${url}`);
  }) as typeof fetch;
  return { paths, restore: () => { globalThis.fetch = before; } };
}

integrationTest("#489 B.3: signed-in owner can persist an explicitly verified audiobook chapter", { concurrency: false }, async t => {
  const f = await fixture();
  t.after(() => prisma.user.delete({ where: { id: f.userId } }).then(() => {}));
  const mock = fakeSpotifyChapter();
  try {
    const result = await bindManualAudiobook(f.userId, {
      ...input, targetPlaylistId: f.targetPlaylistId,
    });
    assert.equal(result.chapterDurationMs, 20_039);
    assert.equal(result.effectivePlanningDurationMs, 20_039);
    assert.equal(result.remainingPlanningDurationMs, 279_961);
    assert.equal(result.providerDurationMs, null);
    assert.equal(result.manualSpotifyControlRequired, true);
    assert.equal(mock.paths.length, 2);
    const saved = await prisma.targetAudiobookOverlay.findUniqueOrThrow({
      where: { userId_spotifyPlaylistId: {
        userId: f.userId, spotifyPlaylistId: f.spotifyPlaylistId,
      } },
    });
    assert.equal(saved.spotifyAudiobookId, bookId);
    assert.equal(saved.selectedChapterId, chapterId);
    assert.equal(saved.manualConsumedMs, 0);
    assert.equal(saved.selectionMode, "FULL_CHAPTER");
    await assert.rejects(
      bindManualAudiobook(f.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_EXISTING_OVERLAY/,
    );
  } finally { mock.restore(); }
});

integrationTest("#489 B.3: unauthorised target, wrong book or overlong chapter cannot persist", { concurrency: false }, async t => {
  const f = await fixture();
  const other = await fixture();
  t.after(async () => {
    await prisma.user.delete({ where: { id: f.userId } });
    await prisma.user.delete({ where: { id: other.userId } });
  });
  const mock = fakeSpotifyChapter({ audiobookId: "wrongBook" });
  try {
    await assert.rejects(
      bindManualAudiobook(other.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_TARGET_NOT_FOUND_OR_UNBOUND/,
    );
    await assert.rejects(
      bindManualAudiobook(f.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_UNVERIFIED_CHAPTER/,
    );
  } finally { mock.restore(); }
  assert.equal(await prisma.targetAudiobookOverlay.count({ where: { userId: f.userId } }), 0);

  const secondMock = fakeSpotifyChapter({ durationMs: 500_000 });
  try {
    await assert.rejects(
      bindManualAudiobook(f.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_VIRTUAL_DURATION_CHAPTER_EXCEEDS_TARGET/,
    );
  } finally { secondMock.restore(); }
  assert.equal(await prisma.targetAudiobookOverlay.count({ where: { userId: f.userId } }), 0);
});

integrationTest("#489 B.3: active or ambiguous Spotify write blocks manual binding", { concurrency: false }, async t => {
  const f = await fixture();
  t.after(() => prisma.user.delete({ where: { id: f.userId } }).then(() => {}));
  const key = { userId: f.userId, spotifyPlaylistId: f.spotifyPlaylistId };
  await prismaAudiobookWriteFenceStore.begin(key);
  const mock = fakeSpotifyChapter();
  try {
    await assert.rejects(
      bindManualAudiobook(f.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/,
    );
    await prismaAudiobookWriteFenceStore.finish(key, true);
    await assert.rejects(
      bindManualAudiobook(f.userId, { ...input, targetPlaylistId: f.targetPlaylistId }),
      /AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN/,
    );
    assert.equal(await prisma.targetAudiobookOverlay.count({ where: { userId: f.userId } }), 0);
  } finally { mock.restore(); }
});

integrationTest("#489 B.3: manually declared progress does not follow Spotify resume state", { concurrency: false }, async t => {
  const f = await fixture();
  t.after(() => prisma.user.delete({ where: { id: f.userId } }).then(() => {}));
  const mock = fakeSpotifyChapter();
  try {
    const result = await bindManualAudiobook(f.userId, {
      ...input, targetPlaylistId: f.targetPlaylistId,
      selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
    });
    assert.equal(result.effectivePlanningDurationMs, 10_039);
    assert.equal(result.remainingPlanningDurationMs, 289_961);
    const stored = await prisma.targetAudiobookOverlay.findFirstOrThrow({ where: { userId: f.userId } });
    assert.equal(stored.manualConsumedMs, 10_000);
    assert.equal(stored.selectionMode, "MANUAL_REMAINDER");
  } finally { mock.restore(); }
});
