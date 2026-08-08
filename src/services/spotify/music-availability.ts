import type { Candidate } from "@/services/playlist-planner";

export type SpotifyMusicTrackLike = {
  uri?: string | null;
  name?: string | null;
  duration_ms?: number | null;
  type?: string | null;
  is_local?: boolean;
  is_playable?: boolean;
  restrictions?: { reason?: string | null } | null;
  artists?: Array<{ name?: string | null }> | null;
};

export type PlayableMusicCandidateResult = {
  candidate: Candidate | null;
  unavailable: boolean;
  restrictionReason: string | null;
};

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
  return {
    candidate: {
      uri: track.uri,
      type: "MUSIC",
      title: track.name,
      ...(artistNames ? { subtitle: artistNames } : {}),
      durationMs: track.duration_ms,
    },
    unavailable: false,
    restrictionReason: null,
  };
}
