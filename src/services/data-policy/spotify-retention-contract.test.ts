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

test("Gate 6A contract covers every declared dataset exactly once", () => {
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

test("explicit Sonoriza preferences and the user account survive provider disconnect", () => {
  for (const dataset of [
    "FIRST_PARTY_PLAYBACK_PREFERENCE",
    "NATIVE_SOURCE_PREFERENCE",
    "USER_ACCOUNT",
    "SOURCE_PLAYLIST_BINDING",
    "TARGET_PLAYLIST_BINDING",
    "MUSIC_INGESTION_BINDING",
  ] as const) {
    assert.equal(
      spotifyDisconnectRuleFor(dataset).action,
      "RETAIN_FIRST_PARTY",
      dataset,
    );
  }
});

test("provider caches and ingestion runtime payload are cleared without deleting first-party bindings", () => {
  assert.equal(
    spotifyDisconnectRuleFor("SOURCE_PLAYLIST_CACHE").action,
    "CLEAR_PROVIDER_PAYLOAD",
  );
  assert.equal(
    spotifyDisconnectRuleFor("MUSIC_INGESTION_RUNTIME_STATE").action,
    "CLEAR_PROVIDER_PAYLOAD",
  );
});

test("generation audit is retained only after provider fields are redacted", () => {
  assert.equal(
    spotifyDisconnectRuleFor("GENERATION_AUDIT").action,
    "REDACT_PROVIDER_FIELDS",
  );
});

test("disconnect preview is non-mutating and accounts for mixed-lineage rows separately", () => {
  const inventory: SpotifyDisconnectInventory = {
    oauthAccount: 1,
    sourcePlaylistCache: 2,
    sourcePlaylistBinding: 3,
    targetPlaylistBinding: 4,
    musicIngestionRuntimeState: 5,
    musicIngestionBinding: 6,
    trackListeningState: 7,
    spotifyListeningEvent: 8,
    mixedListeningEvent: 9,
    spotifyExtendedHistoryImportRun: 10,
    episodeListeningState: 11,
    likedTrackPreference: 12,
    artistAffinityEvidence: 13,
    artistAffinityState: 14,
    artistSimilaritySeed: 15,
    artistSimilarityEdge: 16,
    musicPreferenceSignal: 17,
    albumRecommendationMemory: 18,
    generationAuditWithProviderFields: 19,
    firstPartyPlaybackPreference: 20,
    nativeSourcePreference: 21,
    userAccount: 1,
  };

  const preview = buildSpotifyDisconnectPreview(inventory);
  const history = preview.items.find(
    (item) => item.dataset === "TRACK_LISTENING_EVENT",
  );

  assert.equal(preview.destructive, true);
  assert.equal(history?.affectedRows, 17);
  assert.equal(preview.sanitizeRows, 17);
  assert.equal(preview.clearPayloadRows, 7);
  assert.equal(preview.redactRows, 19);
  assert.equal(preview.retainedFirstPartyRows, 55);
});
