import { isSpotifyApiError } from "@/services/spotify";

/**
 * An isolated 502 can be degraded as before. A source-scoped GET 404 means
 * that a configured SHOW or source PLAYLIST cannot currently be read (e.g.
 * unavailable in the user's market). Never degrade global/auth/quota errors,
 * saved-episodes failures, local errors or writes.
 *
 * This predicate is called only at the source collection boundary. The
 * incremental collector discards every candidate from a degraded source,
 * replans from other sources and still applies the normal quality gates.
 */
export function isDegradableSpotifySourceFailure(error: unknown): boolean {
  if (!isSpotifyApiError(error) || error.kind !== "HTTP_ERROR") return false;
  if (error.status === 502) return true;

  return (
    error.status === 404 &&
    error.method.toUpperCase() === "GET" &&
    (error.operation === "show-episodes" ||
      error.operation === "playlist-items" ||
      error.operation === "playlist-metadata")
  );
}
