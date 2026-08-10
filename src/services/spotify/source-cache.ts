import type { Candidate } from "@/services/playlist-planner";

// v3 adds canonical Spotify track identity so MUSIC-01 can never be bypassed
// by a snapshot cache produced before playback-history filtering existed.
const MUSIC_SOURCE_CACHE_VERSION = 3;
type CachedMusicCandidate = {
  uri: string;
  spotifyTrackId: string;
  title: string;
  subtitle: string | null;
  durationMs: number;
};
type MusicSourceCachePayload = {
  version: typeof MUSIC_SOURCE_CACHE_VERSION;
  unavailableTrackCount: number;
  candidates: CachedMusicCandidate[];
};

export function encodeMusicSourceCache(
  candidates: Candidate[],
  unavailableTrackCount = 0,
): MusicSourceCachePayload {
  return {
    version: MUSIC_SOURCE_CACHE_VERSION,
    unavailableTrackCount: Math.max(0, Math.trunc(unavailableTrackCount)),
    candidates: candidates
      .filter(
        (candidate): candidate is Candidate & { spotifyTrackId: string } =>
          typeof candidate.spotifyTrackId === "string" && Boolean(candidate.spotifyTrackId),
      )
      .map((candidate) => ({
        uri: candidate.uri,
        spotifyTrackId: candidate.spotifyTrackId,
        title: candidate.title,
        subtitle: candidate.subtitle ?? null,
        durationMs: candidate.durationMs,
      })),
  };
}

export function patchMusicSourceCacheAfterAppend(
  value: unknown,
  appendedCandidates: Candidate[],
): MusicSourceCachePayload | null {
  const payload = decodePayload(value);
  if (!payload) return null;
  if (
    appendedCandidates.some(
      (candidate) =>
        candidate.type !== "MUSIC" ||
        typeof candidate.uri !== "string" ||
        !candidate.uri ||
        typeof candidate.spotifyTrackId !== "string" ||
        !candidate.spotifyTrackId,
    )
  ) {
    return null;
  }
  return encodeMusicSourceCache(
    [...payload.candidates, ...appendedCandidates],
    payload.unavailableTrackCount,
  );
}

export function patchMusicSourceCacheAfterRemove(
  value: unknown,
  removedUris: readonly string[],
): MusicSourceCachePayload | null {
  const payload = decodePayload(value);
  if (!payload) return null;
  const removed = new Set(removedUris.filter(Boolean));
  if (removed.size === 0) {
    return encodeMusicSourceCache(payload.candidates, payload.unavailableTrackCount);
  }

  const cachedUris = new Set(payload.candidates.map((candidate) => candidate.uri));
  if ([...removed].some((uri) => !cachedUris.has(uri))) return null;

  return encodeMusicSourceCache(
    payload.candidates.filter((candidate) => !removed.has(candidate.uri)),
    payload.unavailableTrackCount,
  );
}

export function decodeMusicSourceCache(value: unknown): Candidate[] | null {
  return decodePayload(value)?.candidates ?? null;
}

export function decodeMusicSourceCacheUnavailableTrackCount(value: unknown): number | null {
  return decodePayload(value)?.unavailableTrackCount ?? null;
}

function decodePayload(value: unknown): { candidates: Candidate[]; unavailableTrackCount: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.version !== MUSIC_SOURCE_CACHE_VERSION || !Array.isArray(payload.candidates)) return null;
  if (
    typeof payload.unavailableTrackCount !== "number" ||
    !Number.isFinite(payload.unavailableTrackCount) ||
    payload.unavailableTrackCount < 0
  ) return null;

  const candidates: Candidate[] = [];
  for (const item of payload.candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.uri !== "string" ||
      typeof candidate.spotifyTrackId !== "string" || !candidate.spotifyTrackId ||
      typeof candidate.title !== "string" ||
      typeof candidate.durationMs !== "number" ||
      !Number.isFinite(candidate.durationMs) || candidate.durationMs < 0 ||
      !(candidate.subtitle === null || candidate.subtitle === undefined || typeof candidate.subtitle === "string")
    ) return null;
    candidates.push({
      uri: candidate.uri,
      spotifyTrackId: candidate.spotifyTrackId,
      type: "MUSIC",
      title: candidate.title,
      ...(typeof candidate.subtitle === "string" ? { subtitle: candidate.subtitle } : {}),
      durationMs: candidate.durationMs,
    });
  }
  return { candidates, unavailableTrackCount: Math.trunc(payload.unavailableTrackCount) };
}
