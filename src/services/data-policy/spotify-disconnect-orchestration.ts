import type {
  SpotifyDisconnectExecutionResult,
  SpotifyDisconnectPreparation,
} from "./spotify-disconnect-executor";
import type {
  SpotifyDisconnectInventory,
  SpotifyDisconnectPreview,
} from "./spotify-disconnect-preview";
import {
  buildSpotifyProviderRevocationPlan,
  type SpotifyProviderRevocationPlan,
} from "./spotify-provider-revocation";

export type SpotifyDisconnectUiCounts = Readonly<{
  deleteRows: number;
  sanitizeRows: number;
  redactRows: number;
  clearPayloadRows: number;
  retainedFirstPartyRows: number;
  retainedIndependentRows: number;
}>;

export type SpotifyReconnectRecoveryState = Readonly<{
  spotifyConnected: boolean;
  alternateOauthAccounts: number;
  durableRecoveryReady: boolean;
  reconnectAvailable: boolean;
  sourcePlaylistBindings: number;
  targetPlaylistBindings: number;
}>;

export type SpotifyDisconnectUiState = Readonly<{
  contractVersion: number;
  fingerprint: string;
  confirmationPhrase: string | null;
  destructive: boolean;
  localDisconnectCompleted: boolean;
  counts: SpotifyDisconnectUiCounts;
  recovery: SpotifyReconnectRecoveryState;
  providerRevocation: SpotifyProviderRevocationPlan;
}>;

export function buildSpotifyDisconnectPreparationUiState(
  preparation: SpotifyDisconnectPreparation,
): SpotifyDisconnectUiState {
  const localDisconnectCompleted = !preparation.preview.destructive;

  return {
    contractVersion: preparation.contractVersion,
    fingerprint: preparation.fingerprint,
    confirmationPhrase: localDisconnectCompleted
      ? null
      : preparation.confirmationPhrase,
    destructive: preparation.preview.destructive,
    localDisconnectCompleted,
    counts: summarizePreview(preparation.preview),
    recovery: buildRecoveryState(preparation.inventory),
    providerRevocation: buildSpotifyProviderRevocationPlan({
      localDisconnectCompleted,
    }),
  };
}

export function buildSpotifyDisconnectExecutionUiState(
  result: SpotifyDisconnectExecutionResult,
): SpotifyDisconnectUiState {
  const localDisconnectCompleted = !result.afterPreview.destructive;

  return {
    contractVersion: result.contractVersion,
    fingerprint: result.fingerprint,
    confirmationPhrase: null,
    destructive: result.afterPreview.destructive,
    localDisconnectCompleted,
    counts: summarizePreview(result.afterPreview),
    recovery: buildRecoveryState(result.afterInventory),
    providerRevocation: buildSpotifyProviderRevocationPlan({
      localDisconnectCompleted,
    }),
  };
}

function summarizePreview(
  preview: SpotifyDisconnectPreview,
): SpotifyDisconnectUiCounts {
  return {
    deleteRows: preview.deleteRows,
    sanitizeRows: preview.sanitizeRows,
    redactRows: preview.redactRows,
    clearPayloadRows: preview.clearPayloadRows,
    retainedFirstPartyRows: preview.retainedFirstPartyRows,
    retainedIndependentRows: preview.retainedIndependentRows,
  };
}

function buildRecoveryState(
  inventory: SpotifyDisconnectInventory,
): SpotifyReconnectRecoveryState {
  const spotifyConnected = inventory.oauthAccount > 0;
  const alternateOauthAccounts = inventory.unrelatedOauthAccount;

  return {
    spotifyConnected,
    alternateOauthAccounts,
    durableRecoveryReady: alternateOauthAccounts > 0,
    reconnectAvailable: !spotifyConnected,
    sourcePlaylistBindings: inventory.sourcePlaylistBinding,
    targetPlaylistBindings: inventory.targetPlaylistBinding,
  };
}
