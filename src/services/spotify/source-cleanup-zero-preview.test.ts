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
