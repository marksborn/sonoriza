import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/prisma";
import { AudiobookSelfReportedPreview } from "@/components/AudiobookSelfReportedPreview";
import {
  MANUAL_NOTEBOOK_CONFIRMATION,
  manualNotebookEnabled,
  parseSaveManualNotebookRequest,
  type SaveManualNotebookRequest,
} from "./d7-manual-notebook-contract";
import {
  deleteUserDeclaredAudiobookNotebook,
  readUserDeclaredAudiobookNotebook,
  saveUserDeclaredAudiobookNotebook,
} from "./d7-manual-notebook-store";

const request: SaveManualNotebookRequest = {
  targetPlaylistId: "target-d7",
  expectedRevision: 0,
  bookTitle: "1984",
  chapterLabel: "Apresentação",
  chapterDurationMs: 20_039,
  selection: { mode: "FULL_CHAPTER" },
  confirmation: MANUAL_NOTEBOOK_CONFIRMATION,
};
const flags = {
  AUDIOBOOK02_BIND_UI_MODE: "PREVIEW",
  AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE: "PREVIEW",
  AUDIOBOOK02_MANUAL_NOTEBOOK_MODE: "ACTIVE",
};

test("#489 D.7: notebook saves require 3 explicit feature conditions", () => {
  assert.equal(manualNotebookEnabled(flags), true);
  for (const key of Object.keys(flags)) {
    assert.equal(manualNotebookEnabled({ ...flags, [key]: "OFF" }), false);
  }
  assert.equal(manualNotebookEnabled({}), false);
  assert.equal(manualNotebookEnabled({ AUDIOBOOK02_MANUAL_NOTEBOOK_MODE: "ACTIVE" }), false);
});

test("#489 D.7: strict parser accepts only separate unverified payload", () => {
  const valid = parseSaveManualNotebookRequest(request);
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.value, request);
  const bad: Array<[unknown, string]> = [
    [{ ...request, spotifyAudiobookId: "a".repeat(22) }, "INVALID_BODY"],
    [{ ...request, selectedChapterId: "b".repeat(22) }, "INVALID_BODY"],
    [{ ...request, durationEvidence: "SPOTIFY_VERIFIED" }, "INVALID_BODY"],
    [{ ...request, targetDurationMs: 300_000 }, "INVALID_BODY"],
    [{ ...request, confirmation: "OK" }, "EXPLICIT_CONFIRMATION_REQUIRED"],
    [{ ...request, expectedRevision: -1 }, "INVALID_REVISION"],
    [{ ...request, expectedRevision: 2147483647 }, "INVALID_REVISION"],
    [{ ...request, bookTitle: " " }, "INVALID_DECLARED_CHAPTER_INVALID_LABELS"],
    [{ ...request, chapterDurationMs: 0 }, "INVALID_DECLARED_CHAPTER_INVALID_CHAPTER_DURATION"],
    [{ ...request, selection: { mode: "MANUAL_REMAINDER", consumedMs: 20_039 } },
      "INVALID_DECLARED_CHAPTER_CHAPTER_ALREADY_FINISHED"],
  ];
  for (const [input, expected] of bad) {
    const parsed = parseSaveManualNotebookRequest(input);
    assert.equal(parsed.ok, false, expected);
    if (!parsed.ok) assert.equal(parsed.code, expected);
  }
});

test("#489 D.7: SSR in disabled mode remains temporary-only; enabled adds consent", () => {
  const targets = [{
    id: "target-d7",
    name: "5 minutos",
    spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
    durationMs: 300_000,
  }];
  const disabled = renderToStaticMarkup(
    React.createElement(AudiobookSelfReportedPreview, { targets }),
  );
  assert.match(disabled, /não salva nada no banco/);
  assert.doesNotMatch(disabled, /Salvar anotação manual/);
  const enabled = renderToStaticMarkup(
    React.createElement(AudiobookSelfReportedPreview, {
      targets, notebookEnabled: true,
    }),
  );
  assert.match(enabled, /Caderno manual e histórico/);
  assert.match(enabled, /NÃO comprova a presença do livro no Spotify/);
  assert.match(enabled, /Nenhuma anotação salva/);
  assert.doesNotMatch(enabled, /Aplicar no Spotify/);
});

test("#489 D.7: storage has no Spotify imports, and writer/planner remain separate", () => {
  const pure = readFileSync("src/services/audiobooks/d7-manual-notebook-contract.ts", "utf8");
  const store = readFileSync("src/services/audiobooks/d7-manual-notebook-store.ts", "utf8");
  const route = readFileSync("src/app/api/audiobooks/manual-notebook/route.ts", "utf8");
  const planner = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync("prisma/migrations/20261017190000_audiobook_d7_manual_notebook/migration.sql", "utf8");
  assert.match(route, /manualNotebookEnabled\(process\.env\)/);
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(store, /tx\.targetAudiobookManualEntry\.create/);
  assert.match(store, /revision: \{ increment: 1 \}/);
  assert.match(schema, /model TargetAudiobookManualEntry/);
  assert.match(migration, /USER_DECLARED_UNVERIFIED/);
  assert.match(migration, /prevent_manual_audiobook_entry_change/);
  assert.match(planner, /if \(!simulate && audiobookOverlays.length > 0\)/);
  for (const source of [pure, store, route]) {
    assert.doesNotMatch(source,
      /spotifyRequestAttempt|SpotifyClient|replacePlaylistItems|appendPlaylistItems|getSpotifyAccessToken|readSpotifyAudiobookChapters|GenerationRun\.create/);
  }
});

const dbTest = process.env.DATABASE_URL ? test : test.skip;

dbTest("#489 D.7: database isolates owner, appends revisions, CAS and deletion cascade",
  { concurrency: false }, async t => {
    const id = randomUUID().replaceAll("-", "");
    const [owner, stranger] = await Promise.all([
      prisma.user.create({ data: { email: "d7-owner-" + id + "@example.test" } }),
      prisma.user.create({ data: { email: "d7-other-" + id + "@example.test" } }),
    ]);
    t.after(async () => {
      await prisma.user.delete({ where: { id: owner.id } });
      await prisma.user.delete({ where: { id: stranger.id } });
    });
    const target = await prisma.targetPlaylist.create({
      data: {
        userId: owner.id, spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
        name: "Manual D7 fixture", durationMode: "FIXED",
        fixedDurationSeconds: 300, compositionMode: "PROPORTION",
        updatePolicy: "MANUAL", sequencePattern: ["MUSIC"],
      },
    });
    const firstInput = { ...request, targetPlaylistId: target.id };
    const first = await saveUserDeclaredAudiobookNotebook(owner.id, firstInput);
    assert.equal(first.revision, 1);
    assert.equal(first.bookTitle, "1984");
    assert.equal(first.effectivePlanningDurationMs, 20_039);
    assert.equal(first.remainingPlanningDurationMs, 279_961);
    assert.equal(first.evidenceSource, "USER_DECLARED_UNVERIFIED");
    assert.equal(first.remoteChapterVerified, false);
    assert.equal(first.eligibleForBinding, false);
    assert.equal(first.eligibleForShadowPlanner, false);
    assert.equal(first.automaticPlaylistWritesAllowed, false);

    await assert.rejects(
      () => saveUserDeclaredAudiobookNotebook(stranger.id, firstInput),
      /AUDIOBOOK_NOTEBOOK_TARGET_NOT_FOUND/,
    );
    assert.equal((await readUserDeclaredAudiobookNotebook(stranger.id, target.id)).notebook, null);
    await assert.rejects(
      () => saveUserDeclaredAudiobookNotebook(owner.id, firstInput),
      /AUDIOBOOK_NOTEBOOK_REVISION_CONFLICT/,
    );

    const second = await saveUserDeclaredAudiobookNotebook(owner.id, {
      ...firstInput, expectedRevision: 1,
      chapterLabel: "Capítulo 2",
      chapterDurationMs: 25_000,
      selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
    });
    assert.equal(second.revision, 2);
    assert.equal(second.effectivePlanningDurationMs, 15_000);
    assert.equal(second.remainingPlanningDurationMs, 285_000);
    const read = await readUserDeclaredAudiobookNotebook(owner.id, target.id);
    assert.equal(read.notebook?.revision, 2);
    assert.deepEqual(read.history.map(e => e.revision), [2, 1]);
    assert.deepEqual(read.history.map(e => e.chapterLabel),
      ["Capítulo 2", "Apresentação"]);
    assert.equal((await prisma.targetAudiobookOverlay.count({
      where: { userId: owner.id, targetPlaylistId: target.id },
    })), 0);
    assert.equal((await prisma.generationRun.count({ where: { userId: owner.id } })), 0);

    await assert.rejects(
      () => deleteUserDeclaredAudiobookNotebook(owner.id, target.id, 1),
      /AUDIOBOOK_NOTEBOOK_REVISION_CONFLICT/,
    );
    await assert.rejects(
      () => deleteUserDeclaredAudiobookNotebook(stranger.id, target.id, 2),
      /AUDIOBOOK_NOTEBOOK_REVISION_CONFLICT/,
    );
    await deleteUserDeclaredAudiobookNotebook(owner.id, target.id, 2);
    assert.equal((await readUserDeclaredAudiobookNotebook(owner.id, target.id)).notebook, null);
    assert.equal((await prisma.targetAudiobookManualEntry.count({ where: {
      userId: owner.id,
    } })), 0);
  });

dbTest("#489 D.7: SQL CHECK rejects fake provider evidence, impossible time and history edits",
  { concurrency: false }, async t => {
    const id = randomUUID().replaceAll("-", "");
    const owner = await prisma.user.create({
      data: { email: "d7-check-" + id + "@example.test" },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: owner.id } });
    });
    const target = await prisma.targetPlaylist.create({
      data: {
        userId: owner.id, spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
        name: "D7 check fixture", durationMode: "FIXED",
        fixedDurationSeconds: 300, sequencePattern: ["MUSIC"],
      },
    });
    const saved = await saveUserDeclaredAudiobookNotebook(owner.id, {
      ...request, targetPlaylistId: target.id,
    });
    await assert.rejects(() => prisma.targetAudiobookManualNotebook.update({
      where: { id: saved.id },
      data: { evidenceSource: "SPOTIFY_VERIFIED" },
    }));
    await assert.rejects(() => prisma.targetAudiobookManualNotebook.update({
      where: { id: saved.id },
      data: { consumedMs: 21_000 },
    }));
    const entry = await prisma.targetAudiobookManualEntry.findFirstOrThrow({
      where: { userId: owner.id },
    });
    await assert.rejects(() => prisma.targetAudiobookManualEntry.update({
      where: { id: entry.id },
      data: { bookTitle: "Adulterado" },
    }), /AUDIOBOOK_MANUAL_HISTORY_IMMUTABLE|constraint|Error/);
    assert.equal((await prisma.targetAudiobookManualEntry.findUnique({
      where: { id: entry.id },
    }))?.bookTitle, "1984");
  });
