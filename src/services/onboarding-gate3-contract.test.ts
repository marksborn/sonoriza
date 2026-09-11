import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const onboarding = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const historyInstructions = () =>
  readFileSync(
    "src/services/onboarding/history-instructions.ts",
    "utf8",
  );

test("#205 Gate 3 reuses an existing Spotify connection", () => {
  const source = onboarding();

  assert.match(
    source,
    /provider: "spotify"/,
  );

  assert.match(
    source,
    /Spotify já conectado/,
  );

  assert.match(
    source,
    /redirectTo: ONBOARDING_PATH/,
  );
});

test("#205 Gate 3 includes non-blocking extended-history request", () => {
  const source = onboarding();

  assert.match(
    source,
    /historyStatus: "REQUESTED"/,
  );

  assert.match(
    source,
    /Solicitei — continuar/,
  );

  assert.match(
    source,
    /Fazer isso depois/,
  );

  assert.match(
    source,
    /to: "SOURCES"/,
  );
});

test("#205 Gate 3 centralizes versioned Spotify history instructions", () => {
  const source = historyInstructions();

  assert.match(
    source,
    /version: "2026-09-11"/,
  );

  assert.match(
    source,
    /reviewedAt: "2026-09-11"/,
  );

  assert.match(
    source,
    /Extended Streaming History/,
  );

  assert.match(
    source,
    /spotify\.com\/account\/privacy/,
  );
});

test("#205 Gate 3 loads Spotify playlists lazily only in SOURCES", () => {
  const source = onboarding();

  assert.match(
    source,
    /currentStep === "SOURCES"/,
  );

  assert.match(
    source,
    /listCurrentUserPlaylistsPage/,
  );

  assert.match(
    source,
    /SOURCE_PAGE_SIZE = 12/,
  );

  assert.match(
    source,
    /sourceOffset/,
  );
});

test("#205 Gate 3 distinguishes Spotify quota/rate limiting", () => {
  const source = onboarding();

  assert.match(
    source,
    /getActiveSpotifyBackoff/,
  );

  assert.match(
    source,
    /RATE_LIMITED/,
  );

  assert.match(
    source,
    /QUOTA_EXCEEDED/,
  );
});

test("#205 Gate 3 does not write a destination playlist", () => {
  const source = onboarding();

  assert.doesNotMatch(
    source,
    /replacePlaylistItems/,
  );

  assert.doesNotMatch(
    source,
    /api\/generate/,
  );

  assert.doesNotMatch(
    source,
    /status:\s*"COMPLETED"/,
  );
});
