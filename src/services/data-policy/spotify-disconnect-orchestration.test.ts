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

const inventory = {} as SpotifyDisconnectInventory;

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
    inventory,
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
});

test("clean preparation suppresses destructive confirmation and advances to Spotify Connected Apps", () => {
  const preparation = {
    userId: "user-1",
    contractVersion: 6,
    inventory,
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
});

test("successful execution returns only postcheck state and manual provider revocation step", () => {
  const result = {
    userId: "user-1",
    contractVersion: 6,
    fingerprint: "c".repeat(64),
    beforeInventory: inventory,
    beforePreview: preview({ destructive: true, deleteRows: 4 }),
    afterInventory: inventory,
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
});
