import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AUDIOBOOK_1984_MANUAL_EXAMPLE,
  canonicalManualShowHandoff,
} from "./d11-manual-ux";
import {
  parseManualSecondsToMs,
  previewUserDeclaredChapterDuration,
} from "./d6-self-reported-preview";

test("#489 D.11: /show/ handoff canonicalizes untrusted query params", () => {
  const url = AUDIOBOOK_1984_MANUAL_EXAMPLE.spotifyShowUrl;
  assert.equal(canonicalManualShowHandoff(url + "?si=tracking"), url);
  assert.equal(canonicalManualShowHandoff("spotify:show:5E76EUAq7or1ncd4QNyHjI"), url);
  for (const invalid of [
    "", "https://evil.example/show/5E76EUAq7or1ncd4QNyHjI",
    "https://open.spotify.com/audiobook/5E76EUAq7or1ncd4QNyHjI",
    ["https://open.spotify.com/show/5E76EUAq7or1ncd4QNyHjI"],
  ]) {
    assert.equal(canonicalManualShowHandoff(invalid), null);
  }
});

test("#489 D.11: optional 1984 example uses declared 20.039s and a 5min budget", () => {
  const item = AUDIOBOOK_1984_MANUAL_EXAMPLE;
  assert.equal(item.evidenceSource, "USER_DECLARED_UNVERIFIED");
  const duration = parseManualSecondsToMs(item.chapterSeconds);
  assert.equal(duration, 20_039);
  const preview = previewUserDeclaredChapterDuration({
    targetDurationMs: 300_000,
    bookTitle: item.bookTitle,
    chapterLabel: item.chapterLabel,
    chapterDurationMs: duration!,
    selection: { mode: "FULL_CHAPTER" },
  });
  assert.equal(preview.status, "READY_MANUAL_PREVIEW");
  if (preview.status !== "READY_MANUAL_PREVIEW") return;
  assert.equal(preview.effectivePlanningDurationMs, 20_039);
  assert.equal(preview.remainingPlanningDurationMs, 279_961);
  assert.equal(preview.spotifyWrites, false);
  assert.equal(preview.persisted, false);
});

test("#489 D.11: mobile page prioritizes manual editor and hides catalogue behind disclosure", () => {
  const page = readFileSync("src/app/dashboard/configuracao/audiolivros/page.tsx", "utf8");
  const advanced = readFileSync("src/components/AudiobookManualBindWizard.tsx", "utf8");
  const manual = readFileSync("src/components/AudiobookSelfReportedPreview.tsx", "utf8");
  assert.ok(page.indexOf('<section id="audiobook-manual"') <
    page.indexOf('Consulta avançada por catálogo oficial'));
  assert.match(page, /<details className=/);
  assert.match(page, /canonicalManualShowHandoff/);
  assert.match(advanced, /!declaredShowReference \&\&/);
  assert.match(advanced, /showReference=/);
  assert.match(manual, /AUDIOBOOK_1984_MANUAL_EXAMPLE/);
  assert.match(manual, /Salvar anotação manual \(não verificada\)/);
});
