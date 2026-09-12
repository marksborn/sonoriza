import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

import {
  shouldEnterOnboardingFromState,
} from "@/services/onboarding/entry";

const page = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const activation = () =>
  readFileSync(
    "src/services/onboarding/activation.ts",
    "utf8",
  );

const dashboardLayout = () =>
  readFileSync(
    "src/app/dashboard/layout.tsx",
    "utf8",
  );

test("#205 Gate 7 exposes explicit activation only after approved simulation", () => {
  const source = page();

  assert.match(
    source,
    /onboardingActivationReady/,
  );

  assert.match(
    source,
    /status ===\s*"SUCCESS"/,
  );

  assert.match(
    source,
    /qualityPassed/,
  );

  assert.match(
    source,
    /collectionComplete/,
  );

  assert.match(
    source,
    /Está bom — ativar/,
  );

  assert.match(
    source,
    /activateAndCompleteOnboarding/,
  );
});

test("#205 Gate 7 revalidates the canonical first-run gate before activation", () => {
  const source = activation();

  assert.match(
    source,
    /assessConfiguration/,
  );

  assert.match(
    source,
    /includeDisabledTargetIds/,
  );

  assert.match(
    source,
    /assessCalendar03GenerationConfiguration/,
  );

  assert.match(
    source,
    /getFirstRunGate/,
  );

  assert.match(
    source,
    /if \(!gate\.realRunAllowed\)/,
  );
});

test("#205 Gate 7 activates only the user-scoped target", () => {
  const source = activation();

  assert.match(
    source,
    /id:\s*input\.targetId/,
  );

  assert.match(
    source,
    /userId:\s*input\.userId/,
  );

  assert.match(
    source,
    /enabled:\s*true/,
  );

  assert.match(
    source,
    /prisma\.\$transaction/,
  );
});

test("#205 Gate 7 completes lifecycle atomically with activation", () => {
  const source = activation();

  assert.match(
    source,
    /status:\s*"COMPLETED"/,
  );

  assert.match(
    source,
    /currentStep:\s*"ACTIVATION"/,
  );

  assert.match(
    source,
    /completedAt:\s*now/,
  );

  assert.match(
    source,
    /"SIMULATION"/,
  );

  assert.match(
    source,
    /"ACTIVATION"/,
  );
});

test("#205 Gate 7 activation never performs a real generation or Spotify write", () => {
  const source = activation();

  assert.doesNotMatch(
    source,
    /generatePlaylists/,
  );

  assert.doesNotMatch(
    source,
    /replacePlaylistItems/,
  );

  assert.doesNotMatch(
    source,
    /SpotifyClient/,
  );
});

test("#205 Gate 7 routes a genuinely new account into onboarding", () => {
  assert.equal(
    shouldEnterOnboardingFromState({
      status: null,
      targetCount: 0,
      sourceCount: 0,
    }),
    true,
  );

  assert.equal(
    shouldEnterOnboardingFromState({
      status: "IN_PROGRESS",
      targetCount: 1,
      sourceCount: 1,
    }),
    true,
  );

  assert.equal(
    shouldEnterOnboardingFromState({
      status:
        "READY_FOR_SIMULATION",
      targetCount: 1,
      sourceCount: 1,
    }),
    true,
  );
});

test("#205 Gate 7 preserves completed, skipped and legacy configured users", () => {
  assert.equal(
    shouldEnterOnboardingFromState({
      status: "COMPLETED",
      targetCount: 1,
      sourceCount: 1,
    }),
    false,
  );

  assert.equal(
    shouldEnterOnboardingFromState({
      status: "SKIPPED",
      targetCount: 0,
      sourceCount: 0,
    }),
    false,
  );

  assert.equal(
    shouldEnterOnboardingFromState({
      status: null,
      targetCount: 1,
      sourceCount: 0,
    }),
    false,
  );
});

test("#205 Gate 7 guards the entire dashboard tree", () => {
  const source = dashboardLayout();

  assert.match(
    source,
    /await auth\(\)/,
  );

  assert.match(
    source,
    /shouldEnterOnboarding/,
  );

  assert.match(
    source,
    /redirect\("\/onboarding"\)/,
  );
});
