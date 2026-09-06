import assert from "node:assert/strict";
import test from "node:test";

import {
  SPOTIFY_CONNECTED_APPS_URL,
  SPOTIFY_PROVIDER_REVOCATION_MODE,
  SPOTIFY_PROVIDER_REVOCATION_REASON,
  SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL,
  buildSpotifyProviderRevocationPlan,
} from "./spotify-provider-revocation";

test("Gate 6C never exposes an automated provider revocation path", () => {
  const plan = buildSpotifyProviderRevocationPlan({
    localDisconnectCompleted: true,
  });

  assert.equal(plan.mode, SPOTIFY_PROVIDER_REVOCATION_MODE);
  assert.equal(plan.reason, SPOTIFY_PROVIDER_REVOCATION_REASON);
  assert.equal(plan.canAutomateProviderRevocation, false);
  assert.equal(plan.providerRevocationVerifiedBySonoriza, false);
  assert.equal(plan.connectedAppsUrl, SPOTIFY_CONNECTED_APPS_URL);
  assert.equal(plan.supportUrl, SPOTIFY_PROVIDER_REVOCATION_SUPPORT_URL);
});

test("before local cleanup, the contract requires the transactional disconnect first", () => {
  const plan = buildSpotifyProviderRevocationPlan({
    localDisconnectCompleted: false,
  });

  assert.equal(plan.nextAction, "EXECUTE_LOCAL_DISCONNECT");
  assert.equal(plan.localDisconnectCompleted, false);
});

test("after local cleanup, the next action is the official Spotify Connected Apps page", () => {
  const plan = buildSpotifyProviderRevocationPlan({
    localDisconnectCompleted: true,
  });

  assert.equal(plan.nextAction, "OPEN_SPOTIFY_CONNECTED_APPS");
  assert.equal(plan.connectedAppsUrl, "https://www.spotify.com/account/apps/");
});

test("the Gate 6C contract is pure and contains no token or HTTP endpoint material", () => {
  const serialized = JSON.stringify(
    buildSpotifyProviderRevocationPlan({ localDisconnectCompleted: true }),
  );

  assert.equal(serialized.includes("access_token"), false);
  assert.equal(serialized.includes("refresh_token"), false);
  assert.equal(serialized.includes("api/token"), false);
  assert.equal(serialized.includes("revoke"), false);
});
