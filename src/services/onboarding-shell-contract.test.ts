import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = () => readFileSync("src/app/onboarding/page.tsx", "utf8");

test("#205 Gate 2 exposes authenticated onboarding route", () => {
  const source = page();

  assert.match(source, /const userId = await requireUserId\(\)/);
  assert.match(source, /const session = await auth\(\)/);
  assert.match(source, /if \(!session\?\.user\?\.id\) redirect\("\/"\)/);
});

test("#205 Gate 2 persists progress in the Gate 1 model", () => {
  const source = page();

  assert.match(source, /prisma\.onboardingProgress\.upsert/);
  assert.match(source, /prisma\.onboardingProgress\.update/);
  assert.match(source, /currentStep: nextStep/);
  assert.match(source, /completedSteps: appendPersistedStep/);
});

test("#205 Gate 2 supports continue, back, skip and restart", () => {
  const source = page();

  assert.match(source, /async function continueOnboarding\(\)/);
  assert.match(source, /async function goBack\(\)/);
  assert.match(source, /async function skipOnboarding\(\)/);
  assert.match(source, /async function restartOnboarding\(\)/);

  assert.match(source, /status: "SKIPPED"/);
  assert.match(source, /status: "IN_PROGRESS"/);
});

test("#205 Gate 2 does not integrate providers prematurely", () => {
  const source = page();

  assert.doesNotMatch(source, /SpotifyClient/);
  assert.doesNotMatch(source, /GoogleCalendar/);
  assert.doesNotMatch(source, /playlist.*modify/i);
  assert.doesNotMatch(source, /api\/generate/);
});

test("#205 Gate 2 does not mark onboarding completed", () => {
  const source = page();

  assert.doesNotMatch(source, /status:\s*"COMPLETED"/);
  assert.doesNotMatch(source, /readyForSimulationAt:\s*new Date/);
  assert.doesNotMatch(source, /completedAt:\s*new Date/);
});

test("#205 Gate 2 explicitly blocks progress after Spotify shell", () => {
  const source = page();

  assert.match(
    source,
    /Continuar — disponível no Gate 3/,
  );

  assert.match(
    source,
    /if \(!gate2CanAdvance\(currentStep\)\)/,
  );
});
