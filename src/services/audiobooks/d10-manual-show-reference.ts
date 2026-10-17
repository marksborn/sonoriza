/**
 * AUDIOBOOK-02 D.10: Spotify shows can be used as a USER-DECLARED,
 * unverified source reference for a narrated book. An /show/ URL is NOT an
 * /audiobook/ ID and is NEVER evidence of chapter count, runtime or Spotify
 * playlist membership.
 */
export type ManualSpotifyShowReference =
  Readonly<{ spotifyShowId: string; canonicalUrl: string;
    verifiedAsAudiobook: false; providerChapterDataUsed: false }>;

export function parseManualSpotifyShowReference(
  value: unknown,
): ManualSpotifyShowReference | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const raw = value.trim();
  let id: string | null = null;
  const uri = /^spotify:show:([A-Za-z0-9]{22})$/.exec(raw);
  if (uri) id = uri[1] ?? null;
  if (!id) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password ||
          url.hostname !== "open.spotify.com" ||
          url.port || url.hash ||
          !/^\/show\/[A-Za-z0-9]{22}\/?$/.test(url.pathname)) {
        return null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      id = parts[1] ?? null;
    } catch {
      return null;
    }
  }
  if (!id || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
  return {
    spotifyShowId: id,
    canonicalUrl: "https://open.spotify.com/show/" + id,
    verifiedAsAudiobook: false,
    providerChapterDataUsed: false,
  };
}
