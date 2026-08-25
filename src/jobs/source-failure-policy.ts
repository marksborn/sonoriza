import { isSpotifyApiError } from "@/services/spotify";

/**
 * A 502 means the provider gateway temporarily failed to obtain a valid
 * upstream response. During source collection only, this specific status may
 * degrade one source while every other provider/auth/quota/local failure stays
 * fail-closed.
 */
export function isDegradableSpotifySourceFailure(error: unknown): boolean {
  return (
    isSpotifyApiError(error) &&
    error.kind === "HTTP_ERROR" &&
    error.status === 502
  );
}
