import { prisma } from "@/lib/prisma";
import { spotifyApiErrorFromResponse } from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
export const SPOTIFY_LIBRARY_MODIFY_SCOPE = "user-library-modify";

export class SpotifyLibraryModifyScopeRequiredError extends Error {
  constructor() {
    super(
      "Reconecte o Spotify para autorizar o Sonoriza a adicionar músicas às suas Músicas Curtidas.",
    );
    this.name = "SpotifyLibraryModifyScopeRequiredError";
  }
}

/**
 * Checks the grant stored by Auth.js without touching Spotify. Existing users
 * need one explicit reconnect after HISTORY-04 adds user-library-modify.
 */
export async function hasSpotifyLibraryModifyScope(userId: string): Promise<boolean> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "spotify" },
    select: { scope: true },
  });
  if (!account?.scope) return false;
  return account.scope
    .split(/\s+/)
    .filter(Boolean)
    .includes(SPOTIFY_LIBRARY_MODIFY_SCOPE);
}

/**
 * Save one track to Spotify's current Library API.
 *
 * Spotify deprecated PUT /me/tracks in February 2026; the canonical endpoint is
 * now PUT /me/library with Spotify URIs. We check the stored grant first so an
 * old OAuth grant fails locally and can ask for reconnection without issuing a
 * doomed provider call.
 */
export async function saveSpotifyTrackToLibrary(input: {
  userId: string;
  spotifyTrackId: string;
}): Promise<void> {
  if (!(await hasSpotifyLibraryModifyScope(input.userId))) {
    throw new SpotifyLibraryModifyScopeRequiredError();
  }

  const accessToken = await getSpotifyAccessToken(input.userId);
  const uri = `spotify:track:${input.spotifyTrackId}`;
  const response = await fetch(
    `${API}/me/library?uris=${encodeURIComponent(uri)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  if (response.ok) return;

  throw await spotifyApiErrorFromResponse(response, {
    method: "PUT",
    operation: "spotify-api",
  });
}
