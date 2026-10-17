import assert from "node:assert/strict";
import test from "node:test";
import { explainAudiobookPreviewFailure } from "./d4-preview-guidance";

test("#489 D.4: Brazilian market warning is conditional, never assumed from location", () => {
  const response = explainAudiobookPreviewFailure("AUDIOBOOK_CATALOG_UNAVAILABLE");
  assert.match(response, /BR|Brasil/);
  assert.match(response, /US/);
  assert.match(response, /permissões|autorização/);
  assert.doesNotMatch(response, /Sua conta é brasileira|sua localização/);
});

test("#489 D.4: stale SHADOW reports an actionable read-only next step", () => {
  const message = explainAudiobookPreviewFailure(
    "AUDIOBOOK_MANUAL_HANDOFF_NO_RECENT_SHADOW",
  );
  assert.match(message, /simulação/);
  assert.match(message, /última hora/);
  assert.match(message, /não modifica a playlist/);
});

test("#489 D.4: provider blocked reasons do not instruct use of privileged Spotify APIs", () => {
  for (const code of [
    "NO_OPAQUE_ITEM_FOR_MANUAL_VERIFICATION",
    "BUDGET_OR_PROGRESS_DRIFT",
    "AUDIOBOOK_MANUAL_HANDOFF_READ_FAILED",
    "CATALOG_OR_CHAPTER_GET_UNAVAILABLE",
  ]) {
    const message = explainAudiobookPreviewFailure(code);
    assert.ok(message.length > 25);
    assert.doesNotMatch(message, /autorizar escrita|aplicar automaticamente/i);
  }
  assert.equal(explainAudiobookPreviewFailure(null),
    "Não foi possível concluir a prévia.");
  assert.ok(explainAudiobookPreviewFailure("UNEXPECTED_CODE").length > 15);
});
