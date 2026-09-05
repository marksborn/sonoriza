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
} from "./spotify-disconnect-executor";
import type { SpotifyDisconnectPreservationSnapshot } from "./spotify-disconnect-preservation";
import { SPOTIFY_DISCONNECT_CONTRACT_VERSION } from "./spotify-retention-contract";

function inventory(
  overrides: Partial<SpotifyDisconnectInventory> = {},
): SpotifyDisconnectInventory {
  return {
    oauthAccount: 0,
    unrelatedOauthAccount: 1,
    userProfileProviderFields: 0,
    googleCalendarSelection: 2,
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
    pureLastFmListeningEvent: 3,
    lastFmBackfillRun: 1,
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
    firstPartyPlaybackPreference: 1,
    nativeSourcePreference: 1,
    userAccount: 1,
    ...overrides,
  };
}

function preservation(
  overrides: Partial<SpotifyDisconnectPreservationSnapshot> = {},
): SpotifyDisconnectPreservationSnapshot {
  return {
    unrelatedOauthAccounts: 1,
    googleCalendarSelections: 2,
    independentListeningEvents: 4,
    lastFmBackfillRuns: 1,
    sourcePlaylists: 2,
    targetPlaylists: 1,
    musicPlaybackPolicies: 1,
    podcastShowPolicies: 1,
    musicIngestionRules: 1,
    musicSourceCleanupRuns: 1,
    musicIngestionRuns: 1,
    targetScheduleRuns: 1,
    targetScheduleAttempts: 1,
    pushDeliveries: 1,
    generationRuns: 1,
    generationItems: 1,
    generationLogs: 1,
    probableLikePilotFeedback: 1,
    historyLikeActions: 1,
    historyProbableLikeDismissals: 1,
    firstPartyPlaybackPreferences: 1,
    nativeSourcePreferences: 1,
    users: 1,
    unrelatedOauthFingerprint: "oauth-hash",
    googleCalendarFingerprint: "calendar-hash",
    independentListeningFingerprint: "listening-hash",
    lastFmBackfillFingerprint: "lastfm-hash",
    firstPartyPlaybackPreferenceFingerprint: "first-party-hash",
    nativeSourcePreferenceFingerprint: "native-hash",
    userIdentityFingerprint: "user-hash",
    ...overrides,
  };
}

test("Gate 6B v2 fingerprint is deterministic and changes with inventory", () => {
  const firstInventory = inventory({ oauthAccount: 1, spotifyListeningEvent: 2 });
  const same = {
    ...inventory(),
    spotifyListeningEvent: 2,
    oauthAccount: 1,
  };

  const first = spotifyDisconnectFingerprint("user-1", firstInventory);
  const second = spotifyDisconnectFingerprint("user-1", same);
  const changed = spotifyDisconnectFingerprint(
    "user-1",
    inventory({ oauthAccount: 1, spotifyListeningEvent: 3 }),
  );

  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(
    spotifyDisconnectConfirmationPhrase(first),
    /^DISCONNECT SPOTIFY [A-F0-9]{12}$/,
  );
});

test("Gate 6B v2 rejects an old contract version", () => {
  const current = inventory({ oauthAccount: 1 });
  const fingerprint = spotifyDisconnectFingerprint("user-1", current);

  assert.throws(
    () =>
      assertSpotifyDisconnectAuthorization({
        userId: "user-1",
        contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION - 1,
        inventory: current,
        expectedFingerprint: fingerprint,
        confirmation: spotifyDisconnectConfirmationPhrase(fingerprint),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code ===
        SPOTIFY_DISCONNECT_ERROR_CODES.CONTRACT_VERSION_MISMATCH,
  );
});

test("Gate 6B v2 rejects a stale preview fingerprint", () => {
  const current = inventory({ oauthAccount: 1 });
  const stale = spotifyDisconnectFingerprint(
    "user-1",
    inventory({ oauthAccount: 1, spotifyListeningEvent: 1 }),
  );

  assert.throws(
    () =>
      assertSpotifyDisconnectAuthorization({
        userId: "user-1",
        contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
        inventory: current,
        expectedFingerprint: stale,
        confirmation: spotifyDisconnectConfirmationPhrase(stale),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED,
  );
});

test("Gate 6B v2 requires the exact fingerprint confirmation phrase", () => {
  const current = inventory({ oauthAccount: 1 });
  const fingerprint = spotifyDisconnectFingerprint("user-1", current);

  assert.throws(
    () =>
      assertSpotifyDisconnectAuthorization({
        userId: "user-1",
        contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
        inventory: current,
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
      contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
      inventory: current,
      expectedFingerprint: fingerprint,
      confirmation: spotifyDisconnectConfirmationPhrase(fingerprint),
    }),
    fingerprint,
  );
});

test("Gate 6B v2 postcheck rejects destructive provider residue", () => {
  assert.throws(
    () =>
      assertSpotifyDisconnectPostcheck({
        beforeInventory: inventory({ oauthAccount: 1 }),
        afterInventory: inventory({ spotifyListeningEvent: 1 }),
        preservationBefore: preservation(),
        preservationAfter: preservation(),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
  );
});

test("Gate 6B v2 postcheck accepts retained Last.fm/Google/first-party state", () => {
  assert.doesNotThrow(() =>
    assertSpotifyDisconnectPostcheck({
      beforeInventory: inventory({
        oauthAccount: 1,
        spotifyListeningEvent: 3,
        mixedListeningEvent: 2,
        likedTrackPreference: 4,
      }),
      afterInventory: inventory({
        oauthAccount: 0,
        spotifyListeningEvent: 0,
        mixedListeningEvent: 0,
        pureLastFmListeningEvent: 5,
        likedTrackPreference: 0,
      }),
      preservationBefore: preservation(),
      preservationAfter: preservation(),
    }),
  );
});

test("Gate 6B v2 postcheck rejects mutation of independent evidence even when row counts match", () => {
  assert.throws(
    () =>
      assertSpotifyDisconnectPostcheck({
        beforeInventory: inventory({ oauthAccount: 1 }),
        afterInventory: inventory(),
        preservationBefore: preservation(),
        preservationAfter: preservation({
          independentListeningFingerprint: "changed-listening-hash",
        }),
      }),
    (error) =>
      error instanceof SpotifyDisconnectError &&
      error.code === SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
  );
});
