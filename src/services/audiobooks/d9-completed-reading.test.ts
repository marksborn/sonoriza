import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  singleReadingEnabled, parseCompleteReadingRequest,
  COMPLETE_READING_CONFIRMATION,
} from "./d9-completed-reading-contract";
import {
  completeManualReading, listCompletedManualReadings,
} from "./d9-completed-reading-store";
import {
  saveUserDeclaredAudiobookNotebook,
  readUserDeclaredAudiobookNotebook,
  deleteUserDeclaredAudiobookNotebook,
} from "./d7-manual-notebook-store";
import {
  prismaAudiobookWriteFenceStore, withAudiobookOverlayBindAdmission,
  withAudiobookTargetSettingsAdmission,
} from "./write-admission-store";

const confirmation = COMPLETE_READING_CONFIRMATION;
const selection = { mode: "FULL_CHAPTER" } as const;

test("#489 D.9.2: gate is OFF by default and requires full D.7 fence prerequisites", () => {
  assert.equal(singleReadingEnabled({}), false);
  assert.equal(singleReadingEnabled({
    AUDIOBOOK02_SINGLE_READING_MODE: "ACTIVE",
  }), false);
  assert.equal(singleReadingEnabled({
    AUDIOBOOK02_BIND_UI_MODE: "PREVIEW",
    AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE: "PREVIEW",
    AUDIOBOOK02_MANUAL_NOTEBOOK_MODE: "ACTIVE",
    AUDIOBOOK02_WRITE_FENCE_MODE: "ACTIVE",
    AUDIOBOOK02_SINGLE_READING_MODE: "ACTIVE",
  }), true);
});

test("#489 D.9.2: requires strict revision and explicit completion confirmation", () => {
  const valid = {
    targetPlaylistId: "target-01", expectedRevision: 1,
    confirmation,
  };
  assert.equal(parseCompleteReadingRequest(valid).ok, true);
  for (const invalid of [
    { ...valid, confirmation: "YES" },
    { ...valid, expectedRevision: 0 },
    { ...valid, unexpected: true },
    { ...valid, targetPlaylistId: "" },
    { ...valid, expectedRevision: 1.5 },
  ]) assert.equal(parseCompleteReadingRequest(invalid).ok, false);
});

const dbTest = process.env.DATABASE_URL ? test : test.skip;
dbTest("#489 D.9.2: complete preserves ALL chapters, retains remote fence, allows next book", { concurrency: false }, async t => {
  const previous = {
    SINGLE: process.env.AUDIOBOOK02_SINGLE_READING_MODE,
    UI: process.env.AUDIOBOOK02_BIND_UI_MODE,
    SELF: process.env.AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE,
    NOTE: process.env.AUDIOBOOK02_MANUAL_NOTEBOOK_MODE,
    FENCE: process.env.AUDIOBOOK02_WRITE_FENCE_MODE,
  };
  process.env.AUDIOBOOK02_BIND_UI_MODE = "PREVIEW";
  process.env.AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE = "PREVIEW";
  process.env.AUDIOBOOK02_MANUAL_NOTEBOOK_MODE = "ACTIVE";
  process.env.AUDIOBOOK02_WRITE_FENCE_MODE = "ACTIVE";
  process.env.AUDIOBOOK02_SINGLE_READING_MODE = "ACTIVE";
  t.after(() => {
    for (const [key, name] of Object.entries({
      SINGLE: "AUDIOBOOK02_SINGLE_READING_MODE",
      UI: "AUDIOBOOK02_BIND_UI_MODE",
      SELF: "AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE",
      NOTE: "AUDIOBOOK02_MANUAL_NOTEBOOK_MODE",
      FENCE: "AUDIOBOOK02_WRITE_FENCE_MODE",
    })) {
      const value = previous[key as keyof typeof previous];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const suffix = randomUUID().replaceAll("-", "");
  const owner = await prisma.user.create({ data: {
    email: "d9-owner-" + suffix + "@example.test",
  } });
  const stranger = await prisma.user.create({ data: {
    email: "d9-stranger-" + suffix + "@example.test",
  } });
  t.after(async () => {
    await prisma.user.delete({ where: { id: owner.id } });
    await prisma.user.delete({ where: { id: stranger.id } });
  });
  const remote = "4kYizEAtQhFsrrwD3tFphP";
  const target = await prisma.targetPlaylist.create({ data: {
    userId: owner.id, spotifyPlaylistId: remote, name: "Trabalho",
    durationMode: "FIXED", fixedDurationSeconds: 300,
    sequencePattern: ["MUSIC"],
  } });
  const twin = await prisma.targetPlaylist.create({ data: {
    userId: owner.id, spotifyPlaylistId: "2XdzQAIWPdi9S4TLsytQBT",
    name: "Carro", durationMode: "FIXED", fixedDurationSeconds: 300,
    sequencePattern: ["MUSIC"],
  } });
  const req = { targetPlaylistId: target.id, bookTitle: "1984",
    chapterLabel: "Apresentação", chapterDurationMs: 20_039, selection,
    confirmation: "SALVAR_ANOTACAO_NAO_VERIFICADA" as const,
    expectedRevision: 0,
  };
  const first = await saveUserDeclaredAudiobookNotebook(owner.id, req);
  assert.equal(first.revision, 1);
  await assert.rejects(
    saveUserDeclaredAudiobookNotebook(owner.id, {
      ...req, targetPlaylistId: twin.id, expectedRevision: 0,
      bookTitle: "Outro livro",
    }),
    /AUDIOBOOK_NOTEBOOK_SINGLE_ACTIVE_BOOK_REQUIRED/,
  );
  await assert.rejects(
    saveUserDeclaredAudiobookNotebook(owner.id, {
      ...req, expectedRevision: 1, bookTitle: "Outro livro",
    }),
    /AUDIOBOOK_NOTEBOOK_BOOK_CHANGE_REQUIRES_COMPLETION/,
  );
  const second = await saveUserDeclaredAudiobookNotebook(owner.id, {
    ...req, expectedRevision: 1, chapterLabel: "Capítulo 2",
    chapterDurationMs: 25_000,
  });
  assert.equal(second.revision, 2);
  await assert.rejects(
    deleteUserDeclaredAudiobookNotebook(owner.id, target.id, 2),
    /AUDIOBOOK_NOTEBOOK_COMPLETE_INSTEAD_OF_DELETE/,
  );
  await assert.rejects(
    completeManualReading(stranger.id, {
      targetPlaylistId: target.id, expectedRevision: 2, confirmation,
    }),
    /AUDIOBOOK_READING_NO_ACTIVE_BOOK/,
  );
  await assert.rejects(
    completeManualReading(owner.id, {
      targetPlaylistId: target.id, expectedRevision: 1, confirmation,
    }),
    /AUDIOBOOK_READING_REVISION_CONFLICT/,
  );

  const completed = await completeManualReading(owner.id, {
    targetPlaylistId: target.id, expectedRevision: 2, confirmation,
  });
  assert.equal(completed.status, "COMPLETED_LOCAL_ARCHIVE_ONLY");
  assert.equal(completed.copiedChapters, 2);
  assert.equal(completed.spotifyWrites, false);
  const history = await prisma.userAudiobookCompletedReading.findUniqueOrThrow({
    where: { id: completed.id },
    include: { entries: { orderBy: { revision: "asc" } } },
  });
  assert.deepEqual(history.entries.map(e => [e.revision, e.chapterLabel]), [
    [1, "Apresentação"], [2, "Capítulo 2"],
  ]);
  assert.equal((await readUserDeclaredAudiobookNotebook(owner.id, target.id)).notebook, null);
  await assert.rejects(
    completeManualReading(owner.id, {
      targetPlaylistId: target.id, expectedRevision: 2, confirmation,
    }),
    /AUDIOBOOK_READING_NO_ACTIVE_BOOK/,
  );
  await assert.rejects(
    prismaAudiobookWriteFenceStore.begin({ userId: owner.id, spotifyPlaylistId: remote }),
    /AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_ARCHIVED_BOOK/,
  );
  await assert.rejects(
    withAudiobookOverlayBindAdmission({
      userId: owner.id, targetPlaylistId: target.id, spotifyPlaylistId: remote,
    }, async () => { throw Error("unexpected callback"); }),
    /AUDIOBOOK_BIND_BLOCKED_ARCHIVED_BOOK_PROTECTED/,
  );
  await assert.rejects(
    withAudiobookTargetSettingsAdmission({
      userId: owner.id, targetPlaylistId: target.id, expectedSpotifyPlaylistId: remote,
    }, async () => { throw Error("unexpected callback"); }),
    /AUDIOBOOK_TARGET_CONFIG_BLOCKED_ARCHIVED_BOOK/,
  );

  // After archiving, the same destination may host the NEXT manually
  // declared book; the historic playlist remains fenced for provider writes.
  const next = await saveUserDeclaredAudiobookNotebook(owner.id, {
    ...req, bookTitle: "Admirável Mundo Novo", expectedRevision: 0,
  });
  assert.equal(next.revision, 1);
  assert.equal((await listCompletedManualReadings(owner.id)).length, 1);
  assert.equal((await prisma.userAudiobookCompletedChapter.count({
    where: { readingId: completed.id },
  })), 2);
  // Other owner's history is never returned.
  assert.equal((await listCompletedManualReadings(stranger.id)).length, 0);
});
