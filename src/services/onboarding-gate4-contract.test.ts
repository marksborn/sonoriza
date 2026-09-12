import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const onboarding = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const targetService = () =>
  readFileSync(
    "src/services/onboarding/basic-target.ts",
    "utf8",
  );

const behaviorService = () =>
  readFileSync(
    "src/services/onboarding/basic-behavior.ts",
    "utf8",
  );

const normalDestination = () =>
  readFileSync(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    "utf8",
  );

const normalMusic = () =>
  readFileSync(
    "src/app/dashboard/configuracao/musica/page.tsx",
    "utf8",
  );

test("#205 Gate 4 unlocks destination and music behavior then stops at calendar", () => {
  const source = onboarding();

  assert.match(
    source,
    /from: "DESTINATION",\s+to: "MUSIC_BEHAVIOR"/,
  );

  assert.match(
    source,
    /from: "MUSIC_BEHAVIOR",\s+to: "CALENDAR"/,
  );

  assert.match(
    source,
    /currentStep === "CALENDAR"/,
  );
});

test("#205 Gate 4 keeps onboarding-created target disabled", () => {
  const source = targetService();

  assert.match(
    source,
    /enabled: false/,
  );

  assert.match(
    source,
    /TargetUpdatePolicy\.MANUAL/,
  );
});

test("#205 Gate 4 reuses target destination conflict contract", () => {
  assert.match(
    targetService(),
    /assertTargetDestinationAvailableForUser/,
  );

  assert.match(
    normalDestination(),
    /assertTargetDestinationAvailableForUser/,
  );
});

test("#205 Gate 4 reuses music repeat persistence", () => {
  assert.match(
    onboarding(),
    /saveMusicPlaybackPolicyForUser/,
  );

  assert.match(
    normalMusic(),
    /saveMusicPlaybackPolicyForUser/,
  );
});

test("#205 Gate 4 maps discovery presets to existing target policy", () => {
  const source = behaviorService();

  assert.match(
    source,
    /normalizeTargetDiscoveryPolicy/,
  );

  assert.match(
    source,
    /serializeTargetDiscoveryPolicy/,
  );

  assert.match(source, /CONSERVATIVE/);
  assert.match(source, /BALANCED/);
  assert.match(source, /EXPLORATORY/);
});

test("#205 Gate 4 writes no generated playlist content", () => {
  const source = onboarding();

  assert.doesNotMatch(
    source,
    /replacePlaylistItems/,
  );

  assert.doesNotMatch(
    source,
    /\/api\/generate/,
  );

  assert.doesNotMatch(
    source,
    /status:\s*"COMPLETED"/,
  );
});

test("#205 Gate 4 blocks destination provider calls while Spotify backoff is active", () => {
  const service = targetService();
  const page = onboarding();

  assert.match(
    service,
    /assertSpotifyBackoffInactive/,
  );

  assert.match(
    service,
    /SpotifyBackoffActiveError/,
  );

  assert.match(
    service,
    /OnboardingTargetError\("rate-limit"\)/,
  );

  assert.match(
    page,
    /disabled=\{Boolean\(\s*destinationRateLimitMessage/,
  );

  assert.match(
    page,
    /Aguardar liberação do Spotify/,
  );
});
