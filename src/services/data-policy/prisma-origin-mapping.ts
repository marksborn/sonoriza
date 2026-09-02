import type {
  LikedTrackPreferenceProvenance,
  ListeningEventSource,
} from "@prisma/client";

import type { DataOrigin } from "./provenance";

/**
 * Exhaustive adapter from existing Prisma source enums into the provider-neutral
 * Gate 2 origin contract. `satisfies Record<...>` is intentional: adding a new
 * enum value requires an explicit compliance classification before typecheck can
 * pass.
 */
export const LISTENING_EVENT_ORIGIN = {
  SPOTIFY_RECENTLY_PLAYED: "SPOTIFY",
  SPOTIFY_EXTENDED_HISTORY: "SPOTIFY",
  LASTFM_SCROBBLE: "LASTFM",
  IMPORT: "USER_IMPORT",
} as const satisfies Readonly<Record<ListeningEventSource, DataOrigin>>;

/**
 * Legacy liked-track provenance records synchronization lifecycle rather than
 * first-party intent. Both current values therefore remain conservatively
 * Spotify-originated until explicit Sonoriza preference is modeled separately.
 */
export const LIKED_TRACK_PROVENANCE_ORIGIN = {
  LIKED_TRACK_BACKFILL: "SPOTIFY",
  LIKED_TRACK_SYNC: "SPOTIFY",
} as const satisfies Readonly<Record<LikedTrackPreferenceProvenance, DataOrigin>>;

export function originForListeningEventSource(
  source: ListeningEventSource,
): DataOrigin {
  return LISTENING_EVENT_ORIGIN[source];
}

export function originForLikedTrackPreferenceProvenance(
  provenance: LikedTrackPreferenceProvenance,
): DataOrigin {
  return LIKED_TRACK_PROVENANCE_ORIGIN[provenance];
}
