export const SPOTIFY_RETENTION_DATASETS = [
  "OAUTH_ACCOUNT",
  "SOURCE_PLAYLIST_CACHE",
  "SOURCE_PLAYLIST_BINDING",
  "TARGET_PLAYLIST_BINDING",
  "MUSIC_INGESTION_RUNTIME_STATE",
  "MUSIC_INGESTION_BINDING",
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
 * Gate 6A contract for disconnecting Spotify without deleting the Sonoriza
 * account. The contract is intentionally conservative: provider credentials,
 * provider-derived behavioral state and derived profiles are not retained;
 * first-party configuration and explicit Sonoriza preferences survive.
 *
 * Mixed Last.fm + Spotify listening rows must not be deleted wholesale when an
 * independently sourced Last.fm event can be retained. They are sanitized so
 * Spotify enrichment is removed while the independent event remains.
 *
 * Operational configuration may keep stable provider references required for a
 * future reconnect, but provider payload/cache and behavioral evidence do not.
 */
export const SPOTIFY_DISCONNECT_RETENTION_CONTRACT: readonly SpotifyRetentionRule[] = [
  rule(
    "OAUTH_ACCOUNT",
    "DELETE",
    "Access token, refresh token and Spotify OAuth grant must be removed on disconnect.",
  ),
  rule(
    "SOURCE_PLAYLIST_CACHE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Cached Spotify candidates and snapshots are provider payload, not first-party configuration.",
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
    "MUSIC_INGESTION_RUNTIME_STATE",
    "CLEAR_PROVIDER_PAYLOAD",
    "Cursor/runtime state can contain Spotify-derived state and is not needed while disconnected.",
  ),
  rule(
    "MUSIC_INGESTION_BINDING",
    "RETAIN_FIRST_PARTY",
    "The ingestion rule itself is user configuration and may retain its stable source reference.",
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
    "GENERATION_AUDIT",
    "REDACT_PROVIDER_FIELDS",
    "First-party run audit may remain, but Spotify URIs/ids/provider payload must not be retained indefinitely after disconnect.",
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
