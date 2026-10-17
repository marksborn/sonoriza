/**
 * AUDIOBOOK-02 Gate B (#489): fail-closed provider pre-write fence.
 *
 * This rule applies to every playlist-items mutation, independent of the
 * caller (manual generation, scheduler, KEEP_FILLED, direct client use).
 * The lookup is intentionally injectable for pure/offline tests.
 */

export type AudiobookPlaylistWriteRequest = Readonly<{
  userId: string | null;
  path: string;
  method: string;
}>;

export type AudiobookPlaylistOverlayLookup = (
  userId: string,
  spotifyPlaylistId: string,
) => Promise<boolean>;

export type SpotifyPlaylistItemsMutation = Readonly<{
  spotifyPlaylistId: string;
  method: "PUT" | "POST" | "DELETE" | "PATCH";
}>;

/** Returns null for reads and requests outside the playlist-items writer surface. */
export function parseSpotifyPlaylistItemsMutation(
  path: string,
  method: string,
): SpotifyPlaylistItemsMutation | null {
  const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
  if (
    normalizedMethod !== "PUT" &&
    normalizedMethod !== "POST" &&
    normalizedMethod !== "DELETE" &&
    normalizedMethod !== "PATCH"
  ) return null;
  if (typeof path !== "string") return null;
  const match = /^\/playlists\/([^/?#]+)\/items(?:[?#]|$)/.exec(path);
  if (!match || !match[1]) return null;
  const spotifyPlaylistId = match[1];
  // Real Spotify IDs are alphanumeric; allow unambiguous fixture IDs using
  // '-' and '_' so existing test destinations exercise the actual writer.
  if (!/^[a-zA-Z0-9_-]+$/.test(spotifyPlaylistId)) {
    // An unrecognized write path cannot be confidently checked against the
    // Spotify playlist identity; never send it to the provider.
    throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_INVALID_PLAYLIST_ID");
  }
  return {
    spotifyPlaylistId,
    method: normalizedMethod,
  };
}

/**
 * Always call immediately before the provider mutation (and on each retry).
 * Throws without permitting any remote write if association lookup fails.
 */
export async function assertAudiobookPlaylistMutationAllowed(
  request: AudiobookPlaylistWriteRequest,
  isProtected: AudiobookPlaylistOverlayLookup,
): Promise<void> {
  const mutation = parseSpotifyPlaylistItemsMutation(request.path, request.method);
  if (!mutation) return;
  const userId = request.userId?.trim();
  if (!userId) {
    throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_UNKNOWN_USER");
  }

  // Any thrown DB/lookup error aborts the mutation; no permissive fallback.
  const protectedPlaylist = await isProtected(userId, mutation.spotifyPlaylistId);
  if (protectedPlaylist !== false && protectedPlaylist !== true) {
    throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_INDETERMINATE");
  }
  if (protectedPlaylist) {
    throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_PROTECTED_TARGET");
  }
}
