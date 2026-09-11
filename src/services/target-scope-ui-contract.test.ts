import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("#204 Gate 6 persists a backward-compatible global sharing default", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");

  assert.match(schema, /enum GlobalTargetSharingPolicy[\s\S]*EXCLUSIVE[\s\S]*SHAREABLE/);
  assert.match(
    schema,
    /defaultTargetSharingPolicy\s+GlobalTargetSharingPolicy\s+@default\(EXCLUSIVE\)/,
  );
});

test("#204 Gate 6 exposes source scope and sharing override in destination form", () => {
  const form = readFileSync(
    "src/components/TargetPlaylistForm.tsx",
    "utf8",
  );

  assert.match(form, /name="sourceScopeMode"/);
  assert.match(form, /value="INHERIT_GLOBAL"/);
  assert.match(form, /value="SELECTED_ONLY"/);
  assert.match(form, /name="sourceSelectionIds"/);

  // Sharing options are rendered from a typed tuple and use value={value},
  // so validate the declared contract/options instead of requiring literal HTML.
  assert.match(
    form,
    /type TargetSharingPolicy = "INHERIT_GLOBAL" \| "EXCLUSIVE" \| "SHAREABLE"/,
  );
  assert.match(form, /name="sharingPolicy"/);

  // Do not couple the contract to tuple whitespace/formatting.
  assert.match(form, /"EXCLUSIVE"/);
  assert.match(form, /"Exclusiva"/);
  assert.match(form, /"SHAREABLE"/);
  assert.match(form, /"Compartilhável"/);
  assert.match(form, /value=\{value\}/);
  assert.match(
    form,
    /useState<TargetSharingPolicy>\(initial\.sharingPolicy\)/,
  );
  assert.match(form, /checked=\{sharingPolicy === value\}/);
  assert.match(form, /setSharingPolicy\(value\)/);

});

test("#204 Gate 6 persists source links user-scoped", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    "utf8",
  );

  assert.match(page, /targetPlaylistSource\.createMany/);
  assert.match(page, /userId,/);
  assert.match(page, /sourcePlaylistId/);
  assert.match(page, /normalizedSourceScopeMode === "SELECTED_ONLY"/);
});

test("#204 Gate 6 keeps selected disabled sources visible instead of silently replacing them", () => {
  const form = readFileSync(
    "src/components/TargetPlaylistForm.tsx",
    "utf8",
  );

  assert.match(form, /desativada globalmente/);
  assert.match(form, /vínculo preservado/);
  assert.match(form, /não será usada/);
  assert.match(form, /não fará fallback silencioso/);
});

test("#204 Gate 6 runtime resolves inheritance against the persisted global policy", () => {
  const generator = readFileSync(
    "src/jobs/generate-playlists-incremental.ts",
    "utf8",
  );
  const scheduler = readFileSync(
    "src/jobs/scheduled-generation.ts",
    "utf8",
  );

  assert.match(generator, /defaultTargetSharingPolicy/);
  assert.match(generator, /globalSharingPolicy/);
  assert.match(
    generator,
    /resolveEffectiveSharingPolicy\([\s\S]*target\.sharingPolicy,[\s\S]*globalSharingPolicy/,
  );

  assert.match(scheduler, /defaultTargetSharingPolicy/);
  assert.match(
    scheduler,
    /resolveEffectiveSharingPolicy\([\s\S]*outside\.sharingPolicy,[\s\S]*user\.defaultTargetSharingPolicy/,
  );
});

test("#204 Gate 6 switching to global mode does not erase remembered selected-source links", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    "utf8",
  );

  assert.match(
    page,
    /if \(normalizedSourceScopeMode === "SELECTED_ONLY"\)[\s\S]*targetPlaylistSource\.deleteMany/,
  );
});

test("#204 Gate 6 resolves legacy missing source names for the destination checklist", () => {
  const page = readFileSync(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    "utf8",
  );

  assert.match(page, /sourcePlaylists: playlists/);
  assert.match(page, /sourceDisplayName/);
  assert.match(
    page,
    /spotifyPlaylistNameById\.get\(source\.spotifyId\)/,
  );
  assert.match(
    page,
    /SpotifySourceType\.SAVED_EPISODES[\s\S]*return "Seus episódios"/,
  );
  assert.match(
    page,
    /name: sourceDisplayName\(source, spotifySourceNameById\)/,
  );
});
