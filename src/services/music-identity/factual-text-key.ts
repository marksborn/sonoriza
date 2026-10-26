import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";

/** Existing Last.fm key: keep versions, compact whitespace only in the title. */
export function lastFmMusicIdentityKey(trackName: string | null | undefined, artistName: string | null | undefined): string | null {
  const track = normalizeMusicIdentityText(trackName);
  const artist = normalizeMusicIdentityText(artistName);
  return track && artist ? `${artist}\u0000${track.replace(/\s+/g, "")}` : null;
}
