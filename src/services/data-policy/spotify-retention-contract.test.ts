import assert from "node:assert/strict";
import test from "node:test";

import {
  SPOTIFY_DISCONNECT_RETENTION_CONTRACT,
  SPOTIFY_RETENTION_DATASETS,
  assertSpotifyDisconnectContractComplete,
  spotifyDisconnectRuleFor,
} from "./spotify-retention-contract";
import {
  buildSpotifyDisconnectPreview,
  type SpotifyDisconnectInventory,
} from "./spotify-disconnect-preview";

test("Gate 6A v2 contract covers every declared dataset exactly once", () => {
  assert.doesNotThrow(() => assertSpotifyDisconnectContractComplete());
  assert.equal(
    SPOTIFY_DISCONNECT_RETENTION_CONTRACT.length,
    SPOTIFY_RETENTION_DATASETS.length,
  );
});

test("Spotify OAuth credentials are deleted while unrelated OAuth grants survive", () => {
  assert.equal(spotifyDisconnectRuleFor("OAUTH_ACCOUNT").action, "DELETE");
  assert.equal(
    spotifyDisconnectRuleFor("UNRELATED_OAUTH_ACCOUNT").action,
    "RETAIN_INDEPENDENT_ORIGIN",
  );
});

test("Last.fm and Google state survive a Spotify-only disconnect", () => {
  for (const dataset of [
    "LASTFM_LISTENING_EVENT",
    "LASTFM_BACKFILL_RUN",
    "GOOGLE_CALENDAR_SELECTION",
    "UNRELATED_OAUTH_ACCOUNT",
  ] as const) {
    assert.equal(
      spotifyDisconnectRuleFor(dataset).action,
      "RETAIN_INDEPENDENT_ORIGIN",
      dataset,
    );
  }
});

test("legacy Spotify behavioral/profile state does not survive disconnect", () => {
  for (const dataset of [
    "TRACK_LISTENING_STATE",
    "SPOTIFY_LISTENING_EVENT",
    "SPOTIFY_EXTENDED_HISTORY_IMPORT_RUN",
    "EPISODE_LISTENING_STATE",
    "LIKED_TRACK_PREFERENCE",
    "ARTIST_AFFINITY_EVIDENCE",
    "ARTIST_AFFINITY_STATE",
    "ARTIST_SIMILARITY_SEED",
    "ARTIST_SIMILARITY_EDGE",
    "MUSIC_PREFERENCE_SIGNAL",
    "ALBUM_RECOMMENDATION_MEMORY",
  ] as const) {
    assert.equal(spotifyDisconnectRuleFor(dataset).action, "DELETE", dataset);
  }
});

test("mixed Last.fm plus Spotify listening history is sanitized instead of deleting independent evidence", () => {
  assert.equal(
    spotifyDisconnectRuleFor("MIXED_LISTENING_EVENT").action,
    "SANITIZE_SPOTIFY_LINEAGE",
  );
});

test("explicit Sonoriza configuration and user account survive provider disconnect", () => {
  for (const dataset of [
    "FIRST_PARTY_PLAYBACK_PREFERENCE",
    "NATIVE_SOURCE_PREFERENCE",
    "USER_ACCOUNT",
    "SOURCE_PLAYLIST_BINDING",
    "TARGET_PLAYLIST_BINDING",
    "MUSIC_PLAYBACK_POLICY",
    "PODCAST_SHOW_POLICY",
    "MUSIC_INGESTION_BINDING",
  ] as const) {
    assert.equal(
      spotifyDisconnectRuleFor(dataset).action,
      "RETAIN_FIRST_PARTY",
      dataset,
    );
  }
});

test("provider caches, optional Auth profile and runtime state are cleared without deleting bindings", () => {
  for (const dataset of [
    "USER_PROFILE_PROVIDER_FIELDS",
    "SOURCE_PLAYLIST_CACHE",
    "MUSIC_PLAYBACK_RUNTIME_STATE",
    "PODCAST_SHOW_RUNTIME_STATE",
    "MUSIC_INGESTION_RUNTIME_STATE",
  ] as const) {
    assert.equal(
      spotifyDisconnectRuleFor(dataset).action,
      "CLEAR_PROVIDER_PAYLOAD",
      dataset,
    );
  }
});

test("operational audit survives only after selective Spotify field redaction", () => {
  for (const dataset of [
    "MUSIC_SOURCE_CLEANUP_AUDIT",
    "MUSIC_INGESTION_AUDIT",
    "TARGET_SCHEDULE_AUDIT",
    "NOTIFICATION_DELIVERY_AUDIT",
    "PROBABLE_LIKE_PILOT_FEEDBACK",
    "HISTORY_LIKE_ACTION",
    "HISTORY_PROBABLE_LIKE_DISMISSAL",
    "GENERATION_AUDIT",
  ] as const) {
    assert.equal(
      spotifyDisconnectRuleFor(dataset).action,
      "REDACT_PROVIDER_FIELDS",
      dataset,
    );
  }

  assert.match(
    spotifyDisconnectRuleFor("GENERATION_AUDIT").reason,
    /Last\.fm MUSIC-06 explainability may remain/,
  );
});

test("disconnect preview reports pure Spotify delete and mixed-row sanitize separately", () => {
  const inventory: SpotifyDisconnectInventory = {
    oauthAccount: 1,
    unrelatedOauthAccount: 1,
    userProfileProviderFields: 1,
    googleCalendarSelection: 1,
    sourcePlaylistCache: 1,
    sourcePlaylistBinding: 1,
    targetPlaylistBinding: 1,
    musicPlaybackRuntimeState: 1,
    musicPlaybackPolicy: 1,
    podcastShowRuntimeState: 1,
    podcastShowPolicy: 1,
    musicIngestionRuntimeState: 1,
    musicIngestionBinding: 1,
    musicSourceCleanupAudit: 1,
    musicIngestionAudit: 1,
    targetScheduleAudit: 1,
    notificationDeliveryAudit: 1,
    trackListeningState: 1,
    spotifyListeningEvent: 1,
    mixedListeningEvent: 1,
    pureLastFmListeningEvent: 1,
    lastFmBackfillRun: 1,
    spotifyExtendedHistoryImportRun: 1,
    episodeListeningState: 1,
    likedTrackPreference: 1,
    artistAffinityEvidence: 1,
    artistAffinityState: 1,
    artistSimilaritySeed: 1,
    artistSimilarityEdge: 1,
    musicPreferenceSignal: 1,
    albumRecommendationMemory: 1,
    probableLikePilotFeedback: 1,
    historyLikeAction: 1,
    historyProbableLikeDismissal: 1,
    generationAuditWithProviderFields: 1,
    firstPartyPlaybackPreference: 1,
    nativeSourcePreference: 1,
    userAccount: 1,
  };

  const preview = buildSpotifyDisconnectPreview(inventory);
  const spotifyHistory = preview.items.find(
    (item) => item.dataset === "SPOTIFY_LISTENING_EVENT",
  );
  const mixedHistory = preview.items.find(
    (item) => item.dataset === "MIXED_LISTENING_EVENT",
  );

  assert.equal(preview.destructive, true);
  assert.equal(spotifyHistory?.action, "DELETE");
  assert.equal(spotifyHistory?.affectedRows, 1);
  assert.equal(mixedHistory?.action, "SANITIZE_SPOTIFY_LINEAGE");
  assert.equal(mixedHistory?.affectedRows, 1);
  assert.equal(preview.deleteRows, 12);
  assert.equal(preview.sanitizeRows, 1);
  assert.equal(preview.clearPayloadRows, 5);
  assert.equal(preview.redactRows, 8);
  assert.equal(preview.retainedFirstPartyRows, 8);
  assert.equal(preview.retainedIndependentRows, 4);
});
