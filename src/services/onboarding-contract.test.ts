import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = () => readFileSync("prisma/schema.prisma", "utf8");

test("#205 Gate 1 persists explicit versioned onboarding state", () => {
  const source = schema();

  assert.match(
    source,
    /enum OnboardingStatus\s*\{\s*NOT_STARTED\s*IN_PROGRESS\s*READY_FOR_SIMULATION\s*COMPLETED\s*SKIPPED\s*\}/s,
  );

  assert.match(source, /model OnboardingProgress\s*\{/);
  assert.match(source, /userId\s+String\s+@id/);
  assert.match(source, /version\s+Int\s+@default\(1\)/);
  assert.match(
    source,
    /status\s+OnboardingStatus\s+@default\(NOT_STARTED\)/,
  );
  assert.match(
    source,
    /currentStep\s+OnboardingStep\s+@default\(WELCOME\)/,
  );
});

test("#205 Gate 1 persists resumable completed and skipped steps", () => {
  const source = schema();

  assert.match(source, /completedSteps\s+Json\s+@default\("\[\]"\)/);
  assert.match(source, /skippedSteps\s+Json\s+@default\("\[\]"\)/);

  assert.match(source, /startedAt\s+DateTime\?/);
  assert.match(source, /readyForSimulationAt\s+DateTime\?/);
  assert.match(source, /completedAt\s+DateTime\?/);
  assert.match(source, /skippedAt\s+DateTime\?/);
});

test("#205 Gate 1 models extended Spotify history independently", () => {
  const source = schema();

  assert.match(
    source,
    /enum OnboardingHistoryStatus\s*\{\s*NOT_REQUESTED\s*REQUESTED\s*FILES_READY\s*IMPORTING\s*IMPORTED\s*FAILED\s*\}/s,
  );

  assert.match(
    source,
    /historyStatus\s+OnboardingHistoryStatus\s+@default\(NOT_REQUESTED\)/,
  );

  assert.match(source, /historyRequestedAt\s+DateTime\?/);
  assert.match(source, /historyFilesReadyAt\s+DateTime\?/);
  assert.match(source, /historyImportedAt\s+DateTime\?/);
});

test("#205 Gate 1 is isolated one-to-one by user with cascade delete", () => {
  const source = schema();

  assert.match(source, /onboardingProgress\s+OnboardingProgress\?/);

  assert.match(
    source,
    /user User @relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
  );
});

test("#205 Gate 1 migration is additive", () => {
  const migration = readFileSync(
    "prisma/migrations/20260911111500_onboarding_gate1/migration.sql",
    "utf8",
  );

  assert.match(migration, /CREATE TYPE "OnboardingStatus"/);
  assert.match(migration, /CREATE TYPE "OnboardingStep"/);
  assert.match(migration, /CREATE TYPE "OnboardingHistoryStatus"/);
  assert.match(migration, /CREATE TABLE "OnboardingProgress"/);
  assert.match(
    migration,
    /FOREIGN KEY \("userId"\)[\s\S]*REFERENCES "User"\("id"\)[\s\S]*ON DELETE CASCADE/,
  );

  assert.doesNotMatch(migration, /DROP TABLE/);
  assert.doesNotMatch(migration, /DROP COLUMN/);
  assert.doesNotMatch(migration, /DELETE FROM/);
});

test("#205 Gate 1 does not couple onboarding to planner domain", () => {
  const plannerTypes = readFileSync(
    "src/services/playlist-planner/types.ts",
    "utf8",
  );

  assert.doesNotMatch(plannerTypes, /Onboarding/);
});
