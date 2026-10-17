/**
 * AUDIOBOOK-02 #489 Gate B.2 — durable admission around remote playlist writes.
 * Pure orchestration; persistence is supplied by the caller.
 *
 * A lease is acquired and COMMITTED before the Spotify request starts.
 * Creation of an audiobook overlay must acquire that same destination's
 * database row lock and require zero active writes + no review requirement.
 *
 * If Spotify's outcome is unknown (timeout, network or 5xx), the durable fence
 * retains reviewRequired even after this process exits. There is NO automatic
 * lease expiry that could allow a late Spotify mutation to erase an audiobook.
 */
import { parseSpotifyPlaylistItemsMutation } from "./playlist-write-guard";

export type AudiobookWriteFenceKey = Readonly<{
  userId: string;
  spotifyPlaylistId: string;
}>;

export type AudiobookWriteFenceStore = Readonly<{
  begin: (key: AudiobookWriteFenceKey) => Promise<void>;
  finish: (key: AudiobookWriteFenceKey, reviewRequired: boolean) => Promise<void>;
}>;

export type SpotifyMutationOutcome = Readonly<{
  method: string;
  path: string;
  userId: string | null;
}>;

/**
 * A status such as 502, network error, or WRITE_TIMEOUT cannot prove the
 * provider left the playlist unchanged. Only definite 4xx rejections
 * (excluding 408/425) are safe to release without demanding reconciliation.
 */
export function requiresAudiobookPlaylistReconciliation(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const candidate = error as { status?: unknown };
  if (typeof candidate.status !== "number" || !Number.isInteger(candidate.status)) {
    return true;
  }
  return !(
    candidate.status >= 400 &&
    candidate.status < 500 &&
    candidate.status !== 408 &&
    candidate.status !== 425
  );
}

/** Returns the provider result unchanged; avoids touching GET or unrelated POSTs. */
export async function withAudiobookWriteAdmission<T>(
  input: SpotifyMutationOutcome,
  store: AudiobookWriteFenceStore,
  execute: () => Promise<T>,
): Promise<T> {
  const mutation = parseSpotifyPlaylistItemsMutation(input.path, input.method);
  if (!mutation) return execute();

  const userId = input.userId?.trim();
  if (!userId) throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_UNKNOWN_USER");
  const key: AudiobookWriteFenceKey = {
    userId,
    spotifyPlaylistId: mutation.spotifyPlaylistId,
  };

  // If begin fails, execute must NEVER run; finish must NOT be called.
  await store.begin(key);
  let result: T;
  try {
    result = await execute();
  } catch (error) {
    // A failure to finish keeps activeWrites > 0, which is fail-closed for
    // any future attempt to associate a manual audiobook.
    await store.finish(key, requiresAudiobookPlaylistReconciliation(error));
    throw error;
  }
  // Must await the DB release before reporting successful execution.
  await store.finish(key, false);
  return result;
}
