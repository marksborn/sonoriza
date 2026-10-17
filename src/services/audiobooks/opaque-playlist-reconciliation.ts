/**
 * AUDIOBOOK-02 Gate D.2 — read-only observation of a playlist that may have
 * an opaque whole-book item. Neither an item=null nor a stable snapshot
 * can establish the audiobook ID, duration, or future writability.
 */
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";

export type AudiobookRemoteObservation = Readonly<{
  status: "BOOK_ID_UNVERIFIABLE";
  snapshotId: string;
  stableSnapshotRead: true;
  listedItemCount: number;
  opaqueItemCount: number;
  opaquePositions: readonly number[];
  musicItemCount: number;
  podcastItemCount: number;
  remoteBookPresenceVerified: false;
  canIdentifyBook: false;
  safeToMutatePlaylist: false;
  eligibleForAutomaticReconciliation: false;
  manualControlRequired: true;
}>;

export function analyzeOpaqueAudiobookPlaylist(
  state: SpotifyTargetPlaylistState,
): AudiobookRemoteObservation {
  if (!state || typeof state.snapshotId !== "string" || !state.snapshotId.trim() ||
      !Array.isArray(state.items)) {
    throw new Error("AUDIOBOOK_REMOTE_INVALID_SNAPSHOT");
  }
  if (state.items.length > 1000) {
    throw new Error("AUDIOBOOK_REMOTE_TOO_MANY_ITEMS_FOR_PREVIEW");
  }
  const opaquePositions: number[] = [];
  let musicItemCount = 0;
  let podcastItemCount = 0;
  for (let index = 0; index < state.items.length; index++) {
    const item = state.items[index];
    if (!item || item.position !== index || !Number.isSafeInteger(item.position)) {
      throw new Error("AUDIOBOOK_REMOTE_INVALID_ITEM_ORDER");
    }
    if (item.type === "MUSIC" && item.uri) {
      musicItemCount += 1;
    } else if (item.type === "PODCAST" && item.uri) {
      podcastItemCount += 1;
    } else {
      // Includes unknown type, absent URI, and item=null. NONE prove the
      // entry is an audiobook, even when there is exactly one.
      opaquePositions.push(index);
    }
  }
  return {
    status: "BOOK_ID_UNVERIFIABLE",
    snapshotId: state.snapshotId,
    stableSnapshotRead: true,
    listedItemCount: state.items.length,
    opaqueItemCount: opaquePositions.length,
    opaquePositions,
    musicItemCount,
    podcastItemCount,
    remoteBookPresenceVerified: false,
    canIdentifyBook: false,
    safeToMutatePlaylist: false,
    eligibleForAutomaticReconciliation: false,
    manualControlRequired: true,
  };
}
