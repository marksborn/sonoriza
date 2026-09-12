import assert from "node:assert/strict";
import {
  readFileSync,
} from "node:fs";
import test from "node:test";

const read = (path: string) =>
  readFileSync(path, "utf8");

test("#205 Gate 8 persists privacy-minimal user-scoped telemetry", () => {
  const schema =
    read("prisma/schema.prisma");

  const telemetry =
    read(
      "src/services/onboarding/telemetry.ts",
    );

  assert.match(
    schema,
    /model OnboardingTelemetryEvent/,
  );

  assert.match(
    schema,
    /userId\s+String/,
  );

  assert.match(
    schema,
    /@@index\(\[userId, createdAt\]\)/,
  );

  assert.match(
    telemetry,
    /sanitizeOnboardingTelemetryMetadata/,
  );

  assert.doesNotMatch(
    telemetry,
    /spotifyPlaylistId|spotifyTrackId|calendarId|accessToken|refreshToken|responseBody/,
  );
});

test("#205 Gate 8 emits the required pilot lifecycle events", () => {
  const telemetry =
    read(
      "src/services/onboarding/telemetry.ts",
    );

  for (const event of [
    "onboardingStarted",
    "stepCompleted",
    "stepFailed",
    "onboardingSkipped",
    "onboardingCompleted",
    "firstSimulationStarted",
    "firstSimulationSucceeded",
    "firstSimulationFailed",
    "firstActivationCompleted",
  ]) {
    assert.match(
      telemetry,
      new RegExp(event),
    );
  }
});

test("#205 Gate 8 instruments resumable step progress and abandonment evidence", () => {
  const page =
    read(
      "src/app/onboarding/page.tsx",
    );

  assert.match(
    page,
    /event:\s*"onboardingStarted"/,
  );

  assert.match(
    page,
    /event:\s*"stepCompleted"/,
  );

  assert.match(
    page,
    /event:\s*"stepFailed"/,
  );

  assert.match(
    page,
    /event:\s*"onboardingSkipped"/,
  );

  assert.match(
    page,
    /event:\s*"configurationAdjusted"/,
  );
});

test("#205 Gate 8 instruments canonical simulation without creating another planner", () => {
  const simulation =
    read(
      "src/services/onboarding/simulation.ts",
    );

  assert.match(
    simulation,
    /generatePlaylists/,
  );

  assert.match(
    simulation,
    /event:\s*"firstSimulationStarted"/,
  );

  assert.match(
    simulation,
    /event:\s*"firstSimulationSucceeded"/,
  );

  assert.match(
    simulation,
    /event:\s*"firstSimulationFailed"/,
  );

  assert.doesNotMatch(
    simulation,
    /replacePlaylistItems/,
  );
});

test("#205 Gate 8 records completion only after Gate 7 activation succeeds", () => {
  const activation =
    read(
      "src/services/onboarding/activation.ts",
    );

  const transactionIndex =
    activation.indexOf(
      "await prisma.$transaction",
    );

  const completedEventIndex =
    activation.indexOf(
      'event: "onboardingCompleted"',
    );

  assert.ok(
    transactionIndex >= 0,
  );

  assert.ok(
    completedEventIndex >
      transactionIndex,
  );

  assert.match(
    activation,
    /event:\s*"firstActivationCompleted"/,
  );

  assert.doesNotMatch(
    activation,
    /generatePlaylists|SpotifyClient|replacePlaylistItems/,
  );
});

test("#205 Gate 8 pilot report measures funnel, API pressure and first real run", () => {
  const report =
    read(
      "scripts/report-onboarding-pilot.ts",
    );

  assert.match(
    report,
    /abandonmentProxyByStep/,
  );

  assert.match(
    report,
    /firstAttemptSuccessRatePercent/,
  );

  assert.match(
    report,
    /spotifyApi/,
  );

  assert.match(
    report,
    /totalCalls/,
  );

  assert.match(
    report,
    /rateLimitedCount/,
  );

  assert.match(
    report,
    /quotaExceededCount/,
  );

  assert.match(
    report,
    /medianMinutesToFirstUsefulRealGeneration/,
  );

  assert.match(
    report,
    /firstRealGeneration/,
  );

  assert.doesNotMatch(
    report,
    /prisma\.[A-Za-z0-9_]+\.(create|update|upsert|delete)/,
  );
});

test("#205 Gate 8 migration is additive", () => {
  const migration =
    read(
      "prisma/migrations/20260912183000_onboarding_gate8_telemetry/migration.sql",
    );

  assert.match(
    migration,
    /CREATE TABLE "OnboardingTelemetryEvent"/,
  );

  assert.doesNotMatch(
    migration,
    /DROP TABLE|DROP COLUMN|TRUNCATE/,
  );
});
