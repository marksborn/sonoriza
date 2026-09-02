import {
  SPOTIFY_DISCONNECT_RETENTION_CONTRACT,
  type SpotifyDisconnectAction,
  type SpotifyRetentionDataset,
} from "./spotify-retention-contract";

export type SpotifyDisconnectInventory = Readonly<{
  oauthAccount: number;
  userProfileProviderFields: number;
  sourcePlaylistCache: number;
  sourcePlaylistBinding: number;
  targetPlaylistBinding: number;
  musicPlaybackRuntimeState: number;
  musicPlaybackPolicy: number;
  podcastShowRuntimeState: number;
  podcastShowPolicy: number;
  musicIngestionRuntimeState: number;
  musicIngestionBinding: number;
  musicSourceCleanupAudit: number;
  musicIngestionAudit: number;
  targetScheduleAudit: number;
  notificationDeliveryAudit: number;
  trackListeningState: number;
  spotifyListeningEvent: number;
  mixedListeningEvent: number;
  spotifyExtendedHistoryImportRun: number;
  episodeListeningState: number;
  likedTrackPreference: number;
  artistAffinityEvidence: number;
  artistAffinityState: number;
  artistSimilaritySeed: number;
  artistSimilarityEdge: number;
  musicPreferenceSignal: number;
  albumRecommendationMemory: number;
  probableLikePilotFeedback: number;
  historyLikeAction: number;
  historyProbableLikeDismissal: number;
  generationAuditWithProviderFields: number;
  firstPartyPlaybackPreference: number;
  nativeSourcePreference: number;
  userAccount: number;
}>;

export type SpotifyDisconnectPreviewItem = Readonly<{
  dataset: SpotifyRetentionDataset;
  action: SpotifyDisconnectAction;
  affectedRows: number;
  reason: string;
}>;

export type SpotifyDisconnectPreview = Readonly<{
  destructive: boolean;
  items: readonly SpotifyDisconnectPreviewItem[];
  deleteRows: number;
  sanitizeRows: number;
  redactRows: number;
  clearPayloadRows: number;
  retainedFirstPartyRows: number;
}>;

export interface SpotifyDisconnectInventoryStore {
  load(userId: string): Promise<SpotifyDisconnectInventory>;
}

const countByDataset: Readonly<
  Record<SpotifyRetentionDataset, keyof SpotifyDisconnectInventory>
> = {
  OAUTH_ACCOUNT: "oauthAccount",
  USER_PROFILE_PROVIDER_FIELDS: "userProfileProviderFields",
  SOURCE_PLAYLIST_CACHE: "sourcePlaylistCache",
  SOURCE_PLAYLIST_BINDING: "sourcePlaylistBinding",
  TARGET_PLAYLIST_BINDING: "targetPlaylistBinding",
  MUSIC_PLAYBACK_RUNTIME_STATE: "musicPlaybackRuntimeState",
  MUSIC_PLAYBACK_POLICY: "musicPlaybackPolicy",
  PODCAST_SHOW_RUNTIME_STATE: "podcastShowRuntimeState",
  PODCAST_SHOW_POLICY: "podcastShowPolicy",
  MUSIC_INGESTION_RUNTIME_STATE: "musicIngestionRuntimeState",
  MUSIC_INGESTION_BINDING: "musicIngestionBinding",
  MUSIC_SOURCE_CLEANUP_AUDIT: "musicSourceCleanupAudit",
  MUSIC_INGESTION_AUDIT: "musicIngestionAudit",
  TARGET_SCHEDULE_AUDIT: "targetScheduleAudit",
  NOTIFICATION_DELIVERY_AUDIT: "notificationDeliveryAudit",
  TRACK_LISTENING_STATE: "trackListeningState",
  TRACK_LISTENING_EVENT: "spotifyListeningEvent",
  SPOTIFY_EXTENDED_HISTORY_IMPORT_RUN: "spotifyExtendedHistoryImportRun",
  EPISODE_LISTENING_STATE: "episodeListeningState",
  LIKED_TRACK_PREFERENCE: "likedTrackPreference",
  ARTIST_AFFINITY_EVIDENCE: "artistAffinityEvidence",
  ARTIST_AFFINITY_STATE: "artistAffinityState",
  ARTIST_SIMILARITY_SEED: "artistSimilaritySeed",
  ARTIST_SIMILARITY_EDGE: "artistSimilarityEdge",
  MUSIC_PREFERENCE_SIGNAL: "musicPreferenceSignal",
  ALBUM_RECOMMENDATION_MEMORY: "albumRecommendationMemory",
  PROBABLE_LIKE_PILOT_FEEDBACK: "probableLikePilotFeedback",
  HISTORY_LIKE_ACTION: "historyLikeAction",
  HISTORY_PROBABLE_LIKE_DISMISSAL: "historyProbableLikeDismissal",
  GENERATION_AUDIT: "generationAuditWithProviderFields",
  FIRST_PARTY_PLAYBACK_PREFERENCE: "firstPartyPlaybackPreference",
  NATIVE_SOURCE_PREFERENCE: "nativeSourcePreference",
  USER_ACCOUNT: "userAccount",
};

export async function previewSpotifyDisconnect(
  userId: string,
  store: SpotifyDisconnectInventoryStore,
): Promise<SpotifyDisconnectPreview> {
  if (!userId.trim()) throw new Error("Spotify disconnect preview requires userId");
  return buildSpotifyDisconnectPreview(await store.load(userId));
}

/**
 * Pure preview. `mixedListeningEvent` is reported separately because the
 * executor sanitizes Spotify enrichment without deleting independently sourced
 * evidence.
 */
export function buildSpotifyDisconnectPreview(
  inventory: SpotifyDisconnectInventory,
): SpotifyDisconnectPreview {
  const items = SPOTIFY_DISCONNECT_RETENTION_CONTRACT.map((entry) => {
    let affectedRows = inventory[countByDataset[entry.dataset]];
    if (entry.dataset === "TRACK_LISTENING_EVENT") {
      affectedRows += inventory.mixedListeningEvent;
    }

    return {
      dataset: entry.dataset,
      action: entry.action,
      affectedRows,
      reason: entry.reason,
    } satisfies SpotifyDisconnectPreviewItem;
  });

  return {
    destructive: items.some(
      (item) =>
        item.affectedRows > 0 &&
        (item.action === "DELETE" ||
          item.action === "SANITIZE_SPOTIFY_LINEAGE" ||
          item.action === "REDACT_PROVIDER_FIELDS" ||
          item.action === "CLEAR_PROVIDER_PAYLOAD"),
    ),
    items,
    deleteRows: sumFor(items, "DELETE"),
    sanitizeRows: sumFor(items, "SANITIZE_SPOTIFY_LINEAGE"),
    redactRows: sumFor(items, "REDACT_PROVIDER_FIELDS"),
    clearPayloadRows: sumFor(items, "CLEAR_PROVIDER_PAYLOAD"),
    retainedFirstPartyRows: sumFor(items, "RETAIN_FIRST_PARTY"),
  };
}

function sumFor(
  items: readonly SpotifyDisconnectPreviewItem[],
  action: SpotifyDisconnectAction,
): number {
  return items.reduce(
    (total, item) => total + (item.action === action ? item.affectedRows : 0),
    0,
  );
}
