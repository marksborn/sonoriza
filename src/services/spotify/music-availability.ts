import type { Candidate } from "@/services/playlist-planner";

export type SpotifyMusicTrackLike = {
  id?: string | null;
  uri?: string | null;
  name?: string | null;
  duration_ms?: number | null;
  type?: string | null;
  is_local?: boolean;
  is_playable?: boolean;
  restrictions?: { reason?: string | null } | null;
  linked_from?: { id?: string | null } | null;
  artists?: Array<{ name?: string | null }> | null;
};

export type PlayableMusicCandidateResult = {
  candidate: Candidate | null;
  unavailable: boolean;
  restrictionReason: string | null;
};

/**
 * Spotify can relink a catalog track to a market-specific replacement. When
 * that happens, `linked_from.id` is the stable identity of the originally
 * requested recording and must win over the replacement id for cooldown/history.
 */
export function canonicalSpotifyTrackId(
  track: Pick<SpotifyMusicTrackLike, "id" | "linked_from"> | null | undefined,
): string | null {
  const linked = track?.linked_from?.id;
  if (typeof linked === "string" && linked.trim()) return linked.trim();
  const id = track?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

export function readPlayableMusicCandidate(
  track: SpotifyMusicTrackLike | null | undefined,
): PlayableMusicCandidateResult {
  if (!track || track.type !== "track" || track.is_local) {
    return { candidate: null, unavailable: false, restrictionReason: null };
  }
  const restrictionReason =
    typeof track.restrictions?.reason === "string" && track.restrictions.reason.trim()
      ? track.restrictions.reason.trim()
      : null;
  if (track.is_playable === false || track.restrictions != null) {
    return { candidate: null, unavailable: true, restrictionReason };
  }
  if (
    typeof track.uri !== "string" || !track.uri ||
    typeof track.name !== "string" || !track.name ||
    typeof track.duration_ms !== "number" ||
    !Number.isFinite(track.duration_ms) || track.duration_ms <= 0
  ) {
    return { candidate: null, unavailable: false, restrictionReason: null };
  }
  const artistNames = (track.artists ?? [])
    .flatMap((artist) =>
      typeof artist.name === "string" && artist.name.trim() ? [artist.name.trim()] : [],
    )
    .join(", ");
  const spotifyTrackId = canonicalSpotifyTrackId(track);
  return {
    candidate: {
      uri: track.uri,
      type: "MUSIC",
      title: track.name,
      ...(artistNames ? { subtitle: artistNames } : {}),
      ...(spotifyTrackId ? { spotifyTrackId } : {}),
      durationMs: track.duration_ms,
    },
    unavailable: false,
    restrictionReason: null,
  };
}
