import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

test("#205 Gate 2 keeps onboarding authenticated", () => {
  const source = page();

  assert.match(source, /const userId = await requireUserId\(\)/);
  assert.match(source, /const session = await auth\(\)/);
  assert.match(
    source,
    /if \(!session\?\.user\?\.id\) redirect\("\/"\)/,
  );
});

test("#205 Gate 2 keeps persisted resumable progress", () => {
  const source = page();

  assert.match(
    source,
    /prisma\.onboardingProgress\.upsert/,
  );

  assert.match(
    source,
    /prisma\.onboardingProgress\.update/,
  );

  assert.match(
    source,
    /currentStep: input\.to/,
  );

  assert.match(
    source,
    /completedSteps: input\.markCompleted/,
  );

  assert.match(
    source,
    /skippedSteps: input\.markSkipped/,
  );
});

test("#205 Gate 2 keeps forward, back, skip and restart navigation", () => {
  const source = page();

  assert.match(
    source,
    /async function moveToStep/,
  );

  assert.match(
    source,
    /async function goBack\(\)/,
  );

  assert.match(
    source,
    /async function skipOnboarding\(\)/,
  );

  assert.match(
    source,
    /async function restartOnboarding\(\)/,
  );

  assert.match(
    source,
    /status: "SKIPPED"/,
  );

  assert.match(
    source,
    /status: "IN_PROGRESS"/,
  );
});

test("#205 Gate 2 still does not complete onboarding prematurely", () => {
  const source = page();

  // Gates posteriores podem avançar o lifecycle até
  // READY_FOR_SIMULATION. O contrato original do Gate 2
  // continua garantindo que o shell não conclui o
  // onboarding automaticamente.
  assert.doesNotMatch(
    source,
    /status:\s*"COMPLETED"/,
  );

  assert.doesNotMatch(
    source,
    /completedAt:\s*new Date/,
  );
});

test("#205 Gate 2 shell remains versioned and shows progress", () => {
  const source = page();

  assert.match(
    source,
    /ONBOARDING_VERSION/,
  );

  assert.match(
    source,
    /onboardingProgressPosition/,
  );

  assert.match(
    source,
    /ProgressDots/,
  );

  assert.match(
    source,
    /Seu progresso é salvo automaticamente/,
  );
});

test("#205 Gate 3 extends the Gate 2 shell instead of bypassing it", () => {
  const source = page();

  assert.match(
    source,
    /from: "WELCOME",\s+to: "SPOTIFY"/,
  );

  assert.match(
    source,
    /from: "SPOTIFY",\s+to: "SPOTIFY_HISTORY"/,
  );

  assert.match(
    source,
    /from: "SPOTIFY_HISTORY",\s+to: "SOURCES"/,
  );

  assert.match(
    source,
    /from: "SOURCES",\s+to: "DESTINATION"/,
  );
});
