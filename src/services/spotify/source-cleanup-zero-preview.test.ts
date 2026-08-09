import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("zero-item MUSIC-02 previews cannot reach destructive confirmation", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/limpeza/page.tsx",
    "utf8",
  );

  assert.match(page, /executablePreview\.removableTrackCount < 1/);
  assert.match(page, /executablePreview\.removalOccurrenceCount < 1/);
  assert.match(
    page,
    /preview\.removableTrackCount > 0 && preview\.removalOccurrenceCount > 0/,
  );
  assert.match(page, /Nada para remover neste preview/);
  assert.match(page, /rotina periódica continua bloqueada/);
});

test("destructive confirmation exposes pending feedback and disables duplicate submit", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/limpeza/page.tsx",
    "utf8",
  );
  const button = readFileSync(
    "src/app/dashboard/configuracao/limpeza/cleanup-submit-button.tsx",
    "utf8",
  );

  assert.match(page, /<CleanupSubmitButton/);
  assert.match(button, /useFormStatus/);
  assert.match(button, /disabled=\{pending\}/);
  assert.match(button, /Removendo \$\{removableTrackCount\} faixa\(s\)\.\.\./);
  assert.match(button, /disabled:cursor-wait/);
});

test("core rejects an empty first cleanup before Spotify sync or DELETE", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const executeStart = source.indexOf(
    "export async function executeMusicSourceCleanupPreview",
  );
  const guard = source.indexOf(
    "Preview sem faixas removíveis não pode concluir a primeira limpeza.",
    executeStart,
  );
  const sync = source.indexOf(
    "const history = await syncRecentlyPlayed(userId, now);",
    executeStart,
  );
  const deleteCall = source.indexOf('method: "DELETE"', executeStart);

  assert.ok(executeStart >= 0);
  assert.ok(guard > executeStart);
  assert.ok(sync > guard);
  assert.ok(deleteCall > guard);
  assert.match(source.slice(executeStart, sync), /!preview\.source\.musicCleanupFirstCompletedAt/);
  assert.match(source.slice(executeStart, sync), /preview\.removableTrackCount < 1/);
  assert.match(source.slice(executeStart, sync), /preview\.removalOccurrenceCount < 1/);
  assert.match(source.slice(executeStart, sync), /plannedUris\.length < 1/);
});

test("core rejects inconsistent persisted cleanup plans", () => {
  const source = readFileSync("src/services/spotify/source-cleanup.ts", "utf8");
  const executeStart = source.indexOf(
    "export async function executeMusicSourceCleanupPreview",
  );
  const sync = source.indexOf(
    "const history = await syncRecentlyPlayed(userId, now);",
    executeStart,
  );
  const preSync = source.slice(executeStart, sync);

  assert.match(preSync, /plannedUris\.length !== uniquePlannedUris\.size/);
  assert.match(preSync, /preview\.removableTrackCount !== plannedUris\.length/);
  assert.match(
    preSync,
    /preview\.removalOccurrenceCount < preview\.removableTrackCount/,
  );
  assert.match(preSync, /O preview de limpeza está inconsistente/);
});
