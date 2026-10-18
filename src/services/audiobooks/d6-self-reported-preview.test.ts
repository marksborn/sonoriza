import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AudiobookSelfReportedPreview } from "@/components/AudiobookSelfReportedPreview";
import {
  USER_DECLARED_AUDIOBOOK_SOURCE,
  formatManualDuration,
  formatUserDeclaredChapterNotes,
  parseManualSecondsToMs,
  previewUserDeclaredChapterDuration,
  type UserDeclaredChapterInput,
  type UserDeclaredChapterResult,
} from "./d6-self-reported-preview";

const valid: UserDeclaredChapterInput = {
  targetDurationMs: 300_000,
  bookTitle: "1984",
  chapterLabel: "Apresentação",
  chapterDurationMs: 20_039,
  selection: { mode: "FULL_CHAPTER" },
};

function noPrivilege(result: UserDeclaredChapterResult) {
  assert.equal(result.durationEvidence, USER_DECLARED_AUDIOBOOK_SOURCE);
  assert.equal(result.remoteChapterVerified, false);
  assert.equal(result.remoteBookPresenceVerified, false);
  assert.equal(result.eligibleForBinding, false);
  assert.equal(result.eligibleForShadowPlanner, false);
  assert.equal(result.eligibleForAutomaticReconciliation, false);
  assert.equal(result.authorizedForAutomaticWrite, false);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.persisted, false);
  assert.equal("spotifyAudiobookId" in result, false);
  assert.equal("selectedChapterId" in result, false);
  assert.equal("spotifyPlaylistId" in result, false);
}

test("#489 D.6: 1984 user-entered 20.039s consumes 20,039ms from 5min only in preview", () => {
  const result = previewUserDeclaredChapterDuration(valid);
  assert.equal(result.status, "READY_MANUAL_PREVIEW");
  noPrivilege(result);
  if (result.status !== "READY_MANUAL_PREVIEW") return;
  assert.equal(result.targetDurationMs, 300_000);
  assert.equal(result.declaredChapterDurationMs, 20_039);
  assert.equal(result.declaredConsumedMs, 0);
  assert.equal(result.effectivePlanningDurationMs, 20_039);
  assert.equal(result.remainingPlanningDurationMs, 279_961);
  assert.equal(result.manualSpotifyControlRequired, true);
  const note = formatUserDeclaredChapterNotes(result, "Minha playlist");
  assert.match(note, /USER_DECLARED_UNVERIFIED/);
  assert.match(note, /RASCUNHO NÃO SALVO/);
  assert.match(note, /NÃO confirmou/);
  assert.match(note, /não cria vínculo/);
  assert.match(note, /Minha playlist/);
  assert.match(note, /4min 39,961s/);
  assert.doesNotMatch(note, /spotify:chapter|spotify:episode|token/i);
});

test("#489 D.6: manual partial progress gives a local non-verified remainder only", () => {
  const result = previewUserDeclaredChapterDuration({
    ...valid,
    selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
  });
  assert.equal(result.status, "READY_MANUAL_PREVIEW");
  noPrivilege(result);
  if (result.status === "READY_MANUAL_PREVIEW") {
    assert.equal(result.declaredConsumedMs, 10_000);
    assert.equal(result.effectivePlanningDurationMs, 10_039);
    assert.equal(result.remainingPlanningDurationMs, 289_961);
  }
});

test("#489 D.6: exact boundary succeeds, overlong chapter fails, no truncation", () => {
  const atBoundary = previewUserDeclaredChapterDuration({
    ...valid, chapterDurationMs: 300_000,
  });
  assert.equal(atBoundary.status, "READY_MANUAL_PREVIEW");
  noPrivilege(atBoundary);
  if (atBoundary.status === "READY_MANUAL_PREVIEW") {
    assert.equal(atBoundary.remainingPlanningDurationMs, 0);
  }
  const tooLong = previewUserDeclaredChapterDuration({
    ...valid, chapterDurationMs: 300_001,
  });
  assert.equal(tooLong.status, "BLOCKED");
  if (tooLong.status === "BLOCKED") assert.equal(tooLong.reason, "CHAPTER_EXCEEDS_TARGET");
  noPrivilege(tooLong);
});

test("#489 D.6: malformed input, negative/finished time and ambiguous labels fail closed", () => {
  const scenarios: Array<[unknown, string]> = [
    [null, "INVALID_INPUT"],
    [{ ...valid, bookTitle: " " }, "INVALID_LABELS"],
    [{ ...valid, chapterLabel: "" }, "INVALID_LABELS"],
    [{ ...valid, chapterLabel: "a".repeat(121) }, "INVALID_LABELS"],
    [{ ...valid, bookTitle: "Injected\nLine" }, "INVALID_LABELS"],
    [{ ...valid, targetDurationMs: -1 }, "INVALID_TARGET_DURATION"],
    [{ ...valid, targetDurationMs: NaN }, "INVALID_TARGET_DURATION"],
    [{ ...valid, targetDurationMs: 0 }, "INVALID_TARGET_DURATION"],
    [{ ...valid, targetDurationMs: 86_400_001 }, "INVALID_TARGET_DURATION"],
    [{ ...valid, chapterDurationMs: 0 }, "INVALID_CHAPTER_DURATION"],
    [{ ...valid, chapterDurationMs: Infinity }, "INVALID_CHAPTER_DURATION"],
    [{ ...valid, chapterDurationMs: 1.2 }, "INVALID_CHAPTER_DURATION"],
    [{ ...valid, chapterDurationMs: 86_400_001 }, "INVALID_CHAPTER_DURATION"],
    [{ ...valid, selection: null }, "INVALID_SELECTION"],
    [{ ...valid, selection: { mode: "FULL_CHAPTER", consumedMs: 100 } }, "INVALID_SELECTION"],
    [{ ...valid, selection: { mode: "MANUAL_REMAINDER", consumedMs: -1 } }, "INVALID_MANUAL_PROGRESS"],
    [{ ...valid, selection: { mode: "MANUAL_REMAINDER", consumedMs: 20_040 } }, "INVALID_MANUAL_PROGRESS"],
    [{ ...valid, selection: { mode: "MANUAL_REMAINDER", consumedMs: 20_039 } }, "CHAPTER_ALREADY_FINISHED"],
    [{ ...valid, selection: { mode: "MANUAL_REMAINDER", consumedMs: 10, other: 1 } }, "INVALID_SELECTION"],
  ];
  for (const [input, reason] of scenarios) {
    const result = previewUserDeclaredChapterDuration(input as UserDeclaredChapterInput);
    assert.equal(result.status, "BLOCKED", reason);
    if (result.status === "BLOCKED") assert.equal(result.reason, reason);
    noPrivilege(result);
  }
});

test("#489 D.6: explicit decimal parser avoids locale ambiguity and float precision loss", () => {
  const validInput: Array<[string, number]> = [
    ["20", 20000], ["20,039", 20039], ["20.039", 20039],
    ["0", 0], ["0.001", 1], ["300", 300000], ["86400", 86400000],
    ["5.3", 5300], ["12,34", 12340],
  ];
  for (const [value, expected] of validInput) {
    assert.equal(parseManualSecondsToMs(value), expected, value);
  }
  for (const value of [
    "", " ", "1:20", "-1", "1e2", "12.3456", "01", ".3",
    "20,000.1", "NaN", "Infinity", "86401", "999999", "1 000",
    "0.0001",
  ]) {
    assert.equal(parseManualSecondsToMs(value), null, value);
  }
  assert.equal(formatManualDuration(20_039), "0min 20,039s");
  assert.equal(formatManualDuration(279_961), "4min 39,961s");
});

test("#489 D.6: input object and labels are untouched, result is local-only", () => {
  const frozen = Object.freeze({
    ...valid,
    selection: Object.freeze({ mode: "FULL_CHAPTER" as const }),
  });
  const copy = JSON.stringify(frozen);
  const result = previewUserDeclaredChapterDuration(frozen);
  noPrivilege(result);
  assert.equal(JSON.stringify(frozen), copy);
  if (result.status === "READY_MANUAL_PREVIEW") {
    assert.equal(result.bookTitle, "1984");
    assert.equal(result.chapterLabel, "Apresentação");
  }
});

test("#489 D.6: SSR exposes non-persisted manual fallback and never an Apply Spotify action", () => {
  const html = renderToStaticMarkup(React.createElement(AudiobookSelfReportedPreview, {
    targets: [{
      id: "target-test",
      name: "Playlist 5 minutos",
      spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
      durationMs: 300_000,
    }],
  }));
  assert.match(html, /Audiolivro · Registro manual/);
  assert.match(html, /Livro e capítulos manuais/);
  assert.match(html, /Preencher exemplo 1984 \(sem salvar\)/);
  assert.match(html, /Calcular prévia manual \(sem salvar\)/);
  assert.match(html, /não salva nada no banco/);
  assert.match(html, /não alimenta a geração de playlists/);
  assert.doesNotMatch(html, /Aplicar no Spotify|Confirmar vínculo do capítulo/);
});

test("#489 D.6: new preview never accesses DB, Spotify or real planner; separated OFF-default UI", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const pure = read("src/services/audiobooks/d6-self-reported-preview.ts");
  const ui = read("src/components/AudiobookSelfReportedPreview.tsx");
  const page = read("src/app/dashboard/configuracao/audiolivros/page.tsx");
  const binder = read("src/app/api/audiobooks/manual-bind/route.ts");
  const planner = read("src/jobs/generate-playlists-incremental.ts");
  assert.match(page, /AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE === "PREVIEW"/);
  assert.match(page, /AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW"/);
  assert.match(binder, /AUDIOBOOK/);
  assert.match(planner, /if \(!simulate && audiobookOverlays.length > 0\)/);
  assert.match(pure, /USER_DECLARED_UNVERIFIED/);
  // Gate D.6 arithmetic is still pure. The optional, independently gated
  // Gate D.7 notebook adds same-origin fetch to the UI only when enabled.
  assert.doesNotMatch(pure,
    /SpotifyClient|spotifyRequestAttempt|readSpotifyAudiobook|prisma|localStorage|sessionStorage|fetch\(|navigator\.clipboard|\.appendPlaylistItems\(|\.replacePlaylistItems\(|\.create\(|\.update\(/);
  assert.doesNotMatch(ui,
    /SpotifyClient|spotifyRequestAttempt|readSpotifyAudiobook|prisma|localStorage|sessionStorage|\.appendPlaylistItems\(|\.replacePlaylistItems\(/);
  assert.match(ui, /notebookEnabled/);
  assert.match(page, /manualNotebookEnabled\(process\.env\)/);
});
