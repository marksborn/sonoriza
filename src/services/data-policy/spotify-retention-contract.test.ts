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

test("Gate 6 contract covers every declared dataset exactly once", () => {
  assert.doesNotThrow(() => assertSpotifyDisconnectContractComplete());
  assert.equal(
    SPOTIFY_DISCONNECT_RETENTION_CONTRACT.length,
    SPOTIFY_RETENTION_DATASETS.length,
  );
});

test("Spotify OAuth credentials are deleted on disconnect", () => {
  assert.equal(spotifyDisconnectRuleFor("OAUTH_ACCOUNT").action, "DELETE");
});

test("provider-derived behavioral state and profiles do not survive disconnect", () => {
  for (const dataset of [
    "TRACK_LISTENING_STATE",
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

test("mixed listening history is sanitized instead of laundering or deleting independent evidence", () => {
  assert.equal(
    spotifyDisconnectRuleFor("TRACK_LISTENING_EVENT").action,
    "SANITIZE_SPOTIFY_LINEAGE",
  );
});

test("explicit Sonoriza configuration and the user account survive provider disconnect", () => {
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

test("provider caches, optional Auth profile and runtime state are cleared without deleting first-party bindings", () => {
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

test("first-party audit survives only after provider fields are redacted", () => {
  for (const dataset of [
    "MUSIC_SOURCE_CLEANUP_AUDIT",
    "MUSIC_INGESTION_AUDIT",
    "TARGET_SCHEDULE_AUDIT",
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
});

test("disconnect preview accounts for mixed lineage and the expanded runtime/audit inventory", () => {
  const inventory: SpotifyDisconnectInventory = {
    oauthAccount: 1,
    userProfileProviderFields: 2,
    sourcePlaylistCache: 2,
    sourcePlaylistBinding: 3,
    targetPlaylistBinding: 4,
    musicPlaybackRuntimeState: 5,
    musicPlaybackPolicy: 6,
    podcastShowRuntimeState: 7,
    podcastShowPolicy: 8,
    musicIngestionRuntimeState: 9,
    musicIngestionBinding: 10,
    musicSourceCleanupAudit: 11,
    musicIngestionAudit: 12,
    targetScheduleAudit: 13,
    trackListeningState: 14,
    spotifyListeningEvent: 15,
    mixedListeningEvent: 16,
    spotifyExtendedHistoryImportRun: 17,
    episodeListeningState: 18,
    likedTrackPreference: 19,
    artistAffinityEvidence: 20,
    artistAffinityState: 21,
    artistSimilaritySeed: 22,
    artistSimilarityEdge: 23,
    musicPreferenceSignal: 24,
    albumRecommendationMemory: 25,
    probableLikePilotFeedback: 26,
    historyLikeAction: 27,
    historyProbableLikeDismissal: 28,
    generationAuditWithProviderFields: 29,
    firstPartyPlaybackPreference: 30,
    nativeSourcePreference: 31,
    userAccount: 1,
  };

  const preview = buildSpotifyDisconnectPreview(inventory);
  const history = preview.items.find(
    (item) => item.dataset === "TRACK_LISTENING_EVENT",
  );

  assert.equal(preview.destructive, true);
  assert.equal(history?.affectedRows, 31);
  assert.equal(preview.sanitizeRows, 31);
  assert.equal(preview.clearPayloadRows, 25);
  assert.equal(preview.redactRows, 146);
  assert.equal(preview.retainedFirstPartyRows, 93);
});
