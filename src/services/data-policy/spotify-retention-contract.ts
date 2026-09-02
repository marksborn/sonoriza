export const SPOTIFY_DISCONNECT_CONTRACT_VERSION = 3 as const;

export const SPOTIFY_RETENTION_DATASETS = [
  "OAUTH_ACCOUNT",
  "USER_PROFILE_PROVIDER_FIELDS",
  "SOURCE_PLAYLIST_CACHE",
  "SOURCE_PLAYLIST_BINDING",
  "TARGET_PLAYLIST_BINDING",
  "MUSIC_PLAYBACK_RUNTIME_STATE",
  "MUSIC_PLAYBACK_POLICY",
  "PODCAST_SHOW_RUNTIME_STATE",
  "PODCAST_SHOW_POLICY",
  "MUSIC_INGESTION_RUNTIME_STATE",
  "MUSIC_INGESTION_BINDING",
  "MUSIC_SOURCE_CLEANUP_AUDIT",
  "MUSIC_INGESTION_AUDIT",
  "TARGET_SCHEDULE_AUDIT",
  "TRACK_LISTENING_STATE",
  "TRACK_LISTENING_EVENT",
  "SPOTIFY_EXTENDED_HISTORY_IMPORT_RUN",
  "EPISODE_LISTENING_STATE",
  "LIKED_TRACK_PREFERENCE",
  "ARTIST_AFFINITY_EVIDENCE",
  "ARTIST_AFFINITY_STATE",
  "ARTIST_SIMILARITY_SEED",
  "ARTIST_SIMILARITY_EDGE",
  "MUSIC_PREFERENCE_SIGNAL",
  "ALBUM_RECOMMENDATION_MEMORY",
  "PROBABLE_LIKE_PILOT_FEEDBACK",
  "HISTORY_LIKE_ACTION",
  "HISTORY_PROBABLE_LIKE_DISMISSAL",
  "GENERATION_AUDIT",
  "FIRST_PARTY_PLAYBACK_PREFERENCE",
  "NATIVE_SOURCE_PREFERENCE",
  "USER_ACCOUNT",
] as const;

export type SpotifyRetentionDataset =
  (typeof SPOTIFY_RETENTION_DATASETS)[number];

export const SPOTIFY_DISCONNECT_ACTIONS = [
  "DELETE",
  "CLEAR_PROVIDER_PAYLOAD",
  "SANITIZE_SPOTIFY_LINEAGE",
  "REDACT_PROVIDER_FIELDS",
  "RETAIN_FIRST_PARTY",
] as const;

export type SpotifyDisconnectAction =
  (typeof SPOTIFY_DISCONNECT_ACTIONS)[number];

export type SpotifyRetentionRule = Readonly<{
  dataset: SpotifyRetentionDataset;
  action: SpotifyDisconnectAction;
  reason: string;
}>;

/**
 * Gate 6 retention contract for disconnecting Spotify without deleting the
 * Sonoriza account. Provider credentials, provider-derived behavioral state and
 * provider payload are not retained. First-party configuration and explicit
 * Sonoriza intent survive.
 *
 * Stable Spotify references that are part of user-authored configuration may be
 * retained for reconnect. That does not authorize their use while disconnected
 * and does not turn provider payload or behavioral evidence into first-party
 * data.
 */
export const SPOTIFY_DISCONNECT_RETENTION_CONTRACT: readonly SpotifyRetentionRule[] = [
  rule(
    "OAUTH_ACCOUNT",
    "DELETE",
    "Access token, refresh token and Spotify OAuth grant must be removed on disconnect.",
  ),
  rule(
    "USER_PROFILE_PROVIDER_FIELDS",
    "CLEAR_PROVIDER_PAYLOAD",
    "Optional Auth.js name/avatar fields have no provider provenance, so they are cleared conservatively while user id and email remain.",
  ),
  rule(
    "SOURCE_PLAYLIST_CACHE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Spotify source names, cached candidates and provider snapshots can be rehydrated after reconnect.",
  ),
  rule(
    "SOURCE_PLAYLIST_BINDING",
    "RETAIN_FIRST_PARTY",
    "The user's selected source configuration may retain its stable Spotify reference for reconnect.",
  ),
  rule(
    "TARGET_PLAYLIST_BINDING",
    "RETAIN_FIRST_PARTY",
    "The user's target configuration is Sonoriza-owned and may retain its stable playlist reference for reconnect.",
  ),
  rule(
    "MUSIC_PLAYBACK_RUNTIME_STATE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Recently Played sync cursors, provider sync timestamps and untyped history boundary state must be cleared.",
  ),
  rule(
    "MUSIC_PLAYBACK_POLICY",
    "RETAIN_FIRST_PARTY",
    "Repeat-window configuration is Sonoriza-owned even when the current provider runtime is unavailable.",
  ),
  rule(
    "PODCAST_SHOW_RUNTIME_STATE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Provider episode cursor, completion round and consumed-episode runtime state are rehydratable provider state.",
  ),
  rule(
    "PODCAST_SHOW_POLICY",
    "RETAIN_FIRST_PARTY",
    "Podcast ordering, limits and explicit start selection are user configuration and survive disconnect.",
  ),
  rule(
    "MUSIC_INGESTION_RUNTIME_STATE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Provider source name, cursor/runtime state, capability response and sync timestamps are not needed while disconnected.",
  ),
  rule(
    "MUSIC_INGESTION_BINDING",
    "RETAIN_FIRST_PARTY",
    "The ingestion rule itself is user configuration and may retain its stable source reference.",
  ),
  rule(
    "MUSIC_SOURCE_CLEANUP_AUDIT",
    "REDACT_PROVIDER_FIELDS",
    "Cleanup timing and aggregate counts may remain, but provider snapshots, URIs and error payload are redacted.",
  ),
  rule(
    "MUSIC_INGESTION_AUDIT",
    "REDACT_PROVIDER_FIELDS",
    "Ingestion run counts and timing may remain, but provider detail/error payload is redacted.",
  ),
  rule(
    "TARGET_SCHEDULE_AUDIT",
    "REDACT_PROVIDER_FIELDS",
    "Schedule outcome/timing may remain, but provider snapshots, details and provider-derived reason text are redacted.",
  ),
  rule(
    "TRACK_LISTENING_STATE",
    "DELETE",
    "Current rows have Spotify identity without typed provenance and originated from provider playback observations.",
  ),
  rule(
    "TRACK_LISTENING_EVENT",
    "SANITIZE_SPOTIFY_LINEAGE",
    "Spotify-origin events are deleted; independently sourced mixed rows retain only their non-Spotify evidence.",
  ),
  rule(
    "SPOTIFY_EXTENDED_HISTORY_IMPORT_RUN",
    "DELETE",
    "Import audit is keyed to a Spotify export package and has no operational purpose after provider-data deletion.",
  ),
  rule(
    "EPISODE_LISTENING_STATE",
    "DELETE",
    "Podcast progress state is derived from Spotify playback-position data.",
  ),
  rule(
    "LIKED_TRACK_PREFERENCE",
    "DELETE",
    "Current liked-track rows are conservatively classified as Spotify Saved Tracks lineage.",
  ),
  rule(
    "ARTIST_AFFINITY_EVIDENCE",
    "DELETE",
    "Affinity evidence is derived from Spotify Saved Tracks.",
  ),
  rule(
    "ARTIST_AFFINITY_STATE",
    "DELETE",
    "Aggregate affinity is derived from Spotify Saved Tracks and cannot outlive its evidence.",
  ),
  rule(
    "ARTIST_SIMILARITY_SEED",
    "DELETE",
    "Similarity seeds are rooted in provider-derived artist affinity even when Last.fm supplied the expansion.",
  ),
  rule(
    "ARTIST_SIMILARITY_EDGE",
    "DELETE",
    "Similarity edges inherit the Spotify-rooted seed lineage and cannot outlive the seed.",
  ),
  rule(
    "MUSIC_PREFERENCE_SIGNAL",
    "DELETE",
    "Current INFERRED_SKIP signals are derived from Spotify Recently Played observations.",
  ),
  rule(
    "ALBUM_RECOMMENDATION_MEMORY",
    "DELETE",
    "Current album recommendation lifecycle is keyed to Spotify catalog identity and derived recommendation state.",
  ),
  rule(
    "PROBABLE_LIKE_PILOT_FEEDBACK",
    "REDACT_PROVIDER_FIELDS",
    "The user's explicit pilot verdict survives, while Spotify identity, catalog text and derived candidate score/reasons are redacted.",
  ),
  rule(
    "HISTORY_LIKE_ACTION",
    "REDACT_PROVIDER_FIELDS",
    "The explicit confirmation audit survives, while Spotify identity, catalog text and derived ranking evidence are redacted.",
  ),
  rule(
    "HISTORY_PROBABLE_LIKE_DISMISSAL",
    "REDACT_PROVIDER_FIELDS",
    "The user's explicit dismissal timing survives, while Spotify identity, catalog text and derived ranking evidence are redacted.",
  ),
  rule(
    "GENERATION_AUDIT",
    "REDACT_PROVIDER_FIELDS",
    "First-party run timing/status may remain, but Spotify URIs, ids, catalog text, duration metadata, provider payload and provider errors are redacted.",
  ),
  rule(
    "FIRST_PARTY_PLAYBACK_PREFERENCE",
    "RETAIN_FIRST_PARTY",
    "Explicit Sonoriza preferences are first-party and must not be erased merely because Spotify is disconnected.",
  ),
  rule(
    "NATIVE_SOURCE_PREFERENCE",
    "RETAIN_FIRST_PARTY",
    "The user's Sonoriza source preference is first-party configuration even if the source is unavailable while disconnected.",
  ),
  rule(
    "USER_ACCOUNT",
    "RETAIN_FIRST_PARTY",
    "Disconnecting one provider is not deletion of the Sonoriza user account.",
  ),
] as const;

const contractByDataset = new Map(
  SPOTIFY_DISCONNECT_RETENTION_CONTRACT.map((entry) => [entry.dataset, entry]),
);

export function spotifyDisconnectRuleFor(
  dataset: SpotifyRetentionDataset,
): SpotifyRetentionRule {
  const entry = contractByDataset.get(dataset);
  if (!entry) {
    throw new Error(`Missing Spotify disconnect retention rule for ${dataset}`);
  }
  return entry;
}

export function assertSpotifyDisconnectContractComplete(): void {
  const seen = new Set<SpotifyRetentionDataset>();
  for (const entry of SPOTIFY_DISCONNECT_RETENTION_CONTRACT) {
    if (seen.has(entry.dataset)) {
      throw new Error(`Duplicate Spotify disconnect retention rule for ${entry.dataset}`);
    }
    seen.add(entry.dataset);
  }

  for (const dataset of SPOTIFY_RETENTION_DATASETS) {
    if (!seen.has(dataset)) {
      throw new Error(`Missing Spotify disconnect retention rule for ${dataset}`);
    }
  }
}

function rule(
  dataset: SpotifyRetentionDataset,
  action: SpotifyDisconnectAction,
  reason: string,
): SpotifyRetentionRule {
  return { dataset, action, reason };
}
