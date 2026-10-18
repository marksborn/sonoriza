/**
 * AUDIOBOOK-02 D.11: manual entry is the primary path for Spotify /show/.
 * This example comes from the explicitly recorded #489 pilot, not a live
 * Spotify catalogue response. Never use it as verified chapter evidence.
 */
import { parseManualSpotifyShowReference } from "./d10-manual-show-reference";

export const AUDIOBOOK_1984_MANUAL_EXAMPLE = Object.freeze({
  bookTitle: "1984",
  spotifyShowUrl: "https://open.spotify.com/show/5E76EUAq7or1ncd4QNyHjI",
  chapterLabel: "Apresentação",
  chapterSeconds: "20,039",
  evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
});

export function canonicalManualShowHandoff(raw: unknown): string | null {
  return parseManualSpotifyShowReference(raw)?.canonicalUrl ?? null;
}
