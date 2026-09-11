import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = () =>
  readFileSync(
    "src/services/source-configuration.ts",
    "utf8",
  );

const configPage = () =>
  readFileSync(
    "src/app/dashboard/configuracao/fontes/page.tsx",
    "utf8",
  );

const onboardingPage = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const spotifyClient = () =>
  readFileSync(
    "src/services/spotify/client.ts",
    "utf8",
  );

test("#205 Gate 3 shares source persistence between normal config and onboarding", () => {
  assert.match(
    configPage(),
    /saveSpotifySourceForUser/,
  );

  assert.match(
    onboardingPage(),
    /saveSpotifySourceForUser/,
  );

  assert.match(
    service(),
    /userId_spotifyType_spotifyId/,
  );
});

test("#205 Gate 3 keeps source writes user-scoped", () => {
  const source = service();

  assert.match(
    source,
    /userId: input\.userId/,
  );

  assert.match(
    source,
    /provider: "spotify"/,
  );

  assert.match(
    source,
    /prisma\.sourcePlaylist\.upsert/,
  );
});

test("#205 Gate 3 validates a playlist against the connected user's visible playlists", () => {
  const source = service();

  assert.match(
    source,
    /listCurrentUserPlaylists\(\)/,
  );

  assert.match(
    source,
    /playlist\.id === spotifyId/,
  );
});

test("#205 Gate 3 maps provider throttling distinctly", () => {
  const source = service();

  assert.match(
    source,
    /RATE_LIMITED/,
  );

  assert.match(
    source,
    /QUOTA_EXCEEDED/,
  );

  assert.match(
    source,
    /"rate-limit"/,
  );
});

test("#205 Gate 3 adds a single-page Spotify playlist reader", () => {
  const source = spotifyClient();

  assert.match(
    source,
    /listCurrentUserPlaylistsPage/,
  );

  assert.match(
    source,
    /\/me\/playlists\?limit=\$\{limit\}&offset=\$\{offset\}/,
  );

  const pageMethod = source.match(
    /async listCurrentUserPlaylistsPage[\s\S]*?\n  }\n\n  \/\*\* Playlists owned/,
  )?.[0];

  assert.ok(pageMethod);

  assert.doesNotMatch(
    pageMethod,
    /while \(url\)/,
  );
});
