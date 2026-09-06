import assert from "node:assert/strict";
import test from "node:test";

import type {
  SpotifyDisconnectExecutionResult,
  SpotifyDisconnectPreparation,
} from "./spotify-disconnect-executor";
import type {
  SpotifyDisconnectInventory,
  SpotifyDisconnectPreview,
} from "./spotify-disconnect-preview";
import {
  buildSpotifyDisconnectExecutionUiState,
  buildSpotifyDisconnectPreparationUiState,
} from "./spotify-disconnect-orchestration";

function inventory(
  input: Partial<SpotifyDisconnectInventory> = {},
): SpotifyDisconnectInventory {
  return {
    oauthAccount: 1,
    unrelatedOauthAccount: 1,
    sourcePlaylistBinding: 4,
    targetPlaylistBinding: 4,
    ...input,
  } as SpotifyDisconnectInventory;
}

function preview(input: Partial<SpotifyDisconnectPreview>): SpotifyDisconnectPreview {
  return {
    destructive: false,
    items: [],
    deleteRows: 0,
    sanitizeRows: 0,
    redactRows: 0,
    clearPayloadRows: 0,
    retainedFirstPartyRows: 0,
    retainedIndependentRows: 0,
    ...input,
  };
}

test("preparation exposes exact confirmation only while local destructive work remains", () => {
  const preparation = {
    userId: "user-1",
    contractVersion: 6,
    inventory: inventory(),
    preview: preview({
      destructive: true,
      deleteRows: 7,
      sanitizeRows: 3,
      retainedIndependentRows: 11,
    }),
    fingerprint: "a".repeat(64),
    confirmationPhrase: "DISCONNECT SPOTIFY AAAAAAAAAAAA",
  } as SpotifyDisconnectPreparation;

  const state = buildSpotifyDisconnectPreparationUiState(preparation);

  assert.equal(state.localDisconnectCompleted, false);
  assert.equal(state.destructive, true);
  assert.equal(state.confirmationPhrase, preparation.confirmationPhrase);
  assert.equal(state.counts.deleteRows, 7);
  assert.equal(state.counts.sanitizeRows, 3);
  assert.equal(state.counts.retainedIndependentRows, 11);
  assert.equal(state.providerRevocation.nextAction, "EXECUTE_LOCAL_DISCONNECT");
  assert.equal(state.providerRevocation.canAutomateProviderRevocation, false);
  assert.equal(state.recovery.spotifyConnected, true);
  assert.equal(state.recovery.alternateOauthAccounts, 1);
  assert.equal(state.recovery.durableRecoveryReady, true);
  assert.equal(state.recovery.reconnectAvailable, false);
  assert.equal(state.recovery.sourcePlaylistBindings, 4);
  assert.equal(state.recovery.targetPlaylistBindings, 4);
});

test("recovery is fail-closed when Spotify is the only durable sign-in provider", () => {
  const preparation = {
    userId: "user-1",
    contractVersion: 6,
    inventory: inventory({ unrelatedOauthAccount: 0 }),
    preview: preview({ destructive: true, deleteRows: 1 }),
    fingerprint: "d".repeat(64),
    confirmationPhrase: "DISCONNECT SPOTIFY DDDDDDDDDDDD",
  } as SpotifyDisconnectPreparation;

  const state = buildSpotifyDisconnectPreparationUiState(preparation);

  assert.equal(state.recovery.spotifyConnected, true);
  assert.equal(state.recovery.alternateOauthAccounts, 0);
  assert.equal(state.recovery.durableRecoveryReady, false);
  assert.equal(state.recovery.reconnectAvailable, false);
});

test("clean preparation suppresses destructive confirmation and exposes reconnect path", () => {
  const preparation = {
    userId: "user-1",
    contractVersion: 6,
    inventory: inventory({ oauthAccount: 0 }),
    preview: preview({
      destructive: false,
      retainedFirstPartyRows: 4,
      retainedIndependentRows: 9,
    }),
    fingerprint: "b".repeat(64),
    confirmationPhrase: "DISCONNECT SPOTIFY BBBBBBBBBBBB",
  } as SpotifyDisconnectPreparation;

  const state = buildSpotifyDisconnectPreparationUiState(preparation);

  assert.equal(state.localDisconnectCompleted, true);
  assert.equal(state.confirmationPhrase, null);
  assert.equal(state.providerRevocation.nextAction, "OPEN_SPOTIFY_CONNECTED_APPS");
  assert.equal(state.providerRevocation.providerRevocationVerifiedBySonoriza, false);
  assert.equal(state.recovery.spotifyConnected, false);
  assert.equal(state.recovery.reconnectAvailable, true);
  assert.equal(state.recovery.durableRecoveryReady, true);
});

test("successful execution returns postcheck state plus reconnect recovery metadata", () => {
  const result = {
    userId: "user-1",
    contractVersion: 6,
    fingerprint: "c".repeat(64),
    beforeInventory: inventory(),
    beforePreview: preview({ destructive: true, deleteRows: 4 }),
    afterInventory: inventory({ oauthAccount: 0 }),
    afterPreview: preview({
      destructive: false,
      retainedFirstPartyRows: 2,
      retainedIndependentRows: 5,
    }),
    mutations: {},
    preservationBefore: {},
    preservationAfter: {},
  } as unknown as SpotifyDisconnectExecutionResult;

  const state = buildSpotifyDisconnectExecutionUiState(result);

  assert.equal(state.localDisconnectCompleted, true);
  assert.equal(state.destructive, false);
  assert.equal(state.confirmationPhrase, null);
  assert.equal(state.counts.deleteRows, 0);
  assert.equal(state.providerRevocation.nextAction, "OPEN_SPOTIFY_CONNECTED_APPS");
  assert.equal(state.recovery.spotifyConnected, false);
  assert.equal(state.recovery.reconnectAvailable, true);
  assert.equal(state.recovery.sourcePlaylistBindings, 4);
  assert.equal(state.recovery.targetPlaylistBindings, 4);
});
