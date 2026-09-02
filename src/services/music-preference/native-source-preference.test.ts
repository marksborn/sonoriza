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
const plannerRuntime = readFileSync(
  "src/jobs/liked-track-source-shadow.ts",
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

test("SOURCE-LIKED-01 native card and preference read stay local-only", () => {
  assert.match(service, /prisma\.nativeSourcePreference\.findUnique/);
  assert.match(service, /prisma\.likedTrackPreference\.groupBy/);
  assert.match(service, /prisma\.likedTrackPreference\.aggregate/);
  assert.match(service, /getNativeLikedTrackSourcePreferenceState/);
  assert.match(service, /providerReads: false/);
  assert.match(service, /spotifyWrites: false/);
  assert.doesNotMatch(service, /SpotifyClient|forUser\(|fetch\(/);

  assert.match(layout, /Músicas Curtidas/);
  assert.match(layout, /Fonte pessoal fixa/);
  assert.match(layout, /Habilitar preferência/);
  assert.match(layout, /Desativar preferência/);
});

test("SOURCE-LIKED-01 productive use requires rollout, consent AND provenance capability", () => {
  assert.match(plannerRuntime, /getNativeLikedTrackSourcePreferenceState/);
  assert.match(plannerRuntime, /resolveLikedTrackSourcePlannerConsentPolicy/);
  assert.match(plannerRuntime, /USER_SOURCE_DISABLED/);
  assert.match(plannerRuntime, /USER_SOURCE_PREFERENCE_ERROR/);
  assert.match(
    plannerRuntime,
    /MASTER_FLAG_AND_USER_ALLOWLIST_AND_TARGET_ID_ALLOWLIST_AND_USER_SOURCE_PREFERENCE/,
  );
  assert.match(plannerRuntime, /sourcePreference\.readError/);
  assert.match(plannerRuntime, /likedTrackPreference\.findMany/);
  assert.doesNotMatch(plannerRuntime, /SpotifyClient|forUser\(/);

  assert.match(service, /SPOTIFY_SAVED_TRACKS/);
  assert.match(service, /policyDecisionForLineage\(lineage, "RECOMMENDATION"\)/);
  assert.match(service, /policyDecisionForLineage\(lineage, "PLANNER_ELIGIBILITY"\)/);
  assert.match(service, /complianceBlocked: true/);

  assert.match(layout, /rollout operacional/);
  assert.match(layout, /interrompe a influência no planner/);
  assert.match(layout, /sem alterar sua biblioteca nem a sincronização da fonte/);
});
