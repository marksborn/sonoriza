import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260828160000_native_source_preference/migration.sql",
  "utf8",
);
const service = readFileSync(
  "src/services/music-preference/native-source-preference.ts",
  "utf8",
);
const layout = readFileSync(
  "src/app/dashboard/configuracao/fontes/layout.tsx",
  "utf8",
);

test("SOURCE-LIKED-01 Gate 5B1 persists a provider-neutral preference disabled by default", () => {
  assert.match(schema, /enum NativeSourceType \{\s+LIKED_TRACKS\s+\}/);
  assert.match(schema, /model NativeSourcePreference \{/);
  assert.match(schema, /enabled\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@unique\(\[userId, type\]\)/);

  assert.match(migration, /CREATE TYPE "NativeSourceType" AS ENUM \('LIKED_TRACKS'\)/);
  assert.match(migration, /"enabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.doesNotMatch(migration, /INSERT\s+INTO/i);
});

test("SOURCE-LIKED-01 Gate 5B1 native card reads local state without provider calls", () => {
  assert.match(service, /prisma\.nativeSourcePreference\.findUnique/);
  assert.match(service, /prisma\.likedTrackPreference\.groupBy/);
  assert.match(service, /prisma\.likedTrackPreference\.aggregate/);
  assert.match(service, /providerReads: false/);
  assert.match(service, /spotifyWrites: false/);
  assert.match(service, /plannerInfluence: false/);
  assert.doesNotMatch(service, /SpotifyClient|forUser\(|fetch\(/);

  assert.match(layout, /Músicas Curtidas/);
  assert.match(layout, /Fonte pessoal fixa/);
  assert.match(layout, /Habilitar preferência/);
  assert.match(layout, /Desativar preferência/);
});

test("SOURCE-LIKED-01 Gate 5B1 does not wire the user preference into planner runtime", () => {
  const runtimeFiles = [
    "src/jobs/generate-playlists.ts",
    "src/jobs/liked-track-source-shadow.ts",
  ];

  for (const path of runtimeFiles) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /nativeSourcePreference/);
    assert.doesNotMatch(source, /native-source-preference/);
  }
});
