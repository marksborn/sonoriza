import assert from "node:assert/strict";
import test from "node:test";

import type { SpotifyDisconnectInventory } from "./spotify-disconnect-preview";
import {
  SPOTIFY_DISCONNECT_ERROR_CODES,
  SpotifyDisconnectError,
  assertSpotifyDisconnectAuthorization,
  assertSpotifyDisconnectPostcheck,
  spotifyDisconnectConfirmationPhrase,
  spotifyDisconnectFingerprint,
  type SpotifyDisconnectPreservationSnapshot,
} from "./spotify-disconnect-executor";

function inventory(
  overrides: Partial<SpotifyDisconnectInventory> = {},
): SpotifyDisconnectInventory {
  return {
    oauthAccount: 0,
    userProfileProviderFields: 0,
    sourcePlaylistCache: 0,
    sourcePlaylistBinding: 0,
    targetPlaylistBinding: 0,
    musicPlaybackRuntimeState: 0,
    musicPlaybackPolicy: 0,
    podcastShowRuntimeState: 0,
    podcastShowPolicy: 0,
    musicIngestionRuntimeState: 0,
    musicIngestionBinding: 0,
    musicSourceCleanupAudit: 0,
    musicIngestionAudit: 0,
    targetScheduleAudit: 0,
    notificationDeliveryAudit: 0,
    trackListeningState: 0,
    spotifyListeningEvent: 0,
    mixedListeningEvent: 0,
    spotifyExtendedHistoryImportRun: 0,
    episodeListeningState: 0,
    likedTrackPreference: 0,
    artistAffinityEvidence: 0,
    artistAffinityState: 0,
    artistSimilaritySeed: 0,
    artistSimilarityEdge: 0,
    musicPreferenceSignal: 0,
    albumRecommendationMemory: 0,
    probableLikePilotFeedback: 0,
    historyLikeAction: 0,
    historyProbableLikeDismissal: 0,
    generationAuditWithProviderFields: 0,
    firstPartyPlaybackPreference: 0,
    nativeSourcePreference: 0,
    userAccount: 1,
    ...overrides,
  };
}

function preservation(
  value = 1,
): SpotifyDisconnectPreservationSnapshot {
  return {
    sourcePlaylists: value,
    targetPlaylists: value,
    musicPlaybackPolicies: value,
    podcastShowPolicies: value,
    musicIngestionRules: value,
    musicSourceCleanupRuns: value,
    musicIngestionRuns: value,
    targetScheduleRuns: value,
    targetScheduleAttempts: value,
    pushDeliveries: value,
    generationRuns: value,
    generationItems: value,
    generationLogs: value,
    probableLikePilotFeedback: value,
    historyLikeActions: value,
    historyProbableLikeDismissals: value,
    firstPartyPlaybackPreferences: value,
    nativeSourcePreferences: value,
    users: 1,
  };
}

test("Gate 6B fingerprint is deterministic and changes when the preview inventory changes", () => {
  const base = inventory({ oauthAccount: 1, spotifyListeningEvent: 2 });
  const sameDifferentConstructionOrder = {
    ...inventory(),
    spotifyListeningEvent: 2,
    oauthAccount: 1,
  };

  const first = spotifyDisconnectFingerprint("user-1", base);
  const second = spotifyDisconnectFingerprint(
    "user-1",
    sameDifferentConstructionOrder,
  );
  const changed = spotifyDisconnectFingerprint(
    "user-1",
    inventory({ oauthAccount: 1, spotifyListeningEvent: 3 }),
  );

  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(spotifyDisconnectConfirmationPhrase(first), /^DISCONNECT SPOTIFY [A-F0-9]{12}$/);
});

test("Gate 6B rejects a stale preview before authorization", () => {
  const snapshot = inventory({ oauthAccount: 1 });
  const staleFingerprint = spotifyDisconnectFingerprint(
    "user-1",
    inventory({ oauthAccount: 1, spotifyListeningEvent: 1 }),
  );

  assert.throws(
    () =>
      assertSpotifyDisconnectAuthorization({
        userId: "user-1",
        inventory: snapshot,
        expectedFingerprint: staleFingerprint,
        confirmation: spotifyDisconnectConfirmationPhrase(staleFingerprint),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED,
  );
});

test("Gate 6B requires the exact confirmation phrase for the current snapshot", () => {
  const snapshot = inventory({ oauthAccount: 1 });
  const fingerprint = spotifyDisconnectFingerprint("user-1", snapshot);

  assert.throws(
    () =>
      assertSpotifyDisconnectAuthorization({
        userId: "user-1",
        inventory: snapshot,
        expectedFingerprint: fingerprint,
        confirmation: "DISCONNECT SPOTIFY",
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.CONFIRMATION_REQUIRED,
  );

  assert.equal(
    assertSpotifyDisconnectAuthorization({
      userId: "user-1",
      inventory: snapshot,
      expectedFingerprint: fingerprint,
      confirmation: spotifyDisconnectConfirmationPhrase(fingerprint),
    }),
    fingerprint,
  );
});

test("Gate 6B postcheck rejects any provider residue", () => {
  assert.throws(
    () =>
      assertSpotifyDisconnectPostcheck({
        beforeInventory: inventory({ oauthAccount: 1 }),
        afterInventory: inventory({ notificationDeliveryAudit: 1 }),
        preservationBefore: preservation(),
        preservationAfter: preservation(),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
  );
});

test("Gate 6B postcheck rejects loss of first-party/audit rows even when provider residue is zero", () => {
  const after = preservation();
  const changed = { ...after, firstPartyPlaybackPreferences: 0 };

  assert.throws(
    () =>
      assertSpotifyDisconnectPostcheck({
        beforeInventory: inventory({ oauthAccount: 1 }),
        afterInventory: inventory(),
        preservationBefore: after,
        preservationAfter: changed,
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
  );
});

test("Gate 6B postcheck accepts zero provider residue with identical preservation counts", () => {
  assert.doesNotThrow(() =>
    assertSpotifyDisconnectPostcheck({
      beforeInventory: inventory({ oauthAccount: 1, likedTrackPreference: 2 }),
      afterInventory: inventory(),
      preservationBefore: preservation(2),
      preservationAfter: preservation(2),
    }),
  );
});
