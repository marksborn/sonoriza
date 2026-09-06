import type {
  SpotifyDisconnectExecutionResult,
  SpotifyDisconnectPreparation,
} from "./spotify-disconnect-executor";
import type { SpotifyDisconnectPreview } from "./spotify-disconnect-preview";
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

export type SpotifyDisconnectUiState = Readonly<{
  contractVersion: number;
  fingerprint: string;
  confirmationPhrase: string | null;
  destructive: boolean;
  localDisconnectCompleted: boolean;
  counts: SpotifyDisconnectUiCounts;
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
