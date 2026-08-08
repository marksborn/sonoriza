import type { Candidate } from "@/services/playlist-planner";

const MUSIC_SOURCE_CACHE_VERSION = 1;

type CachedMusicCandidate = {
  uri: string;
  title: string;
  subtitle: string | null;
  durationMs: number;
};

type MusicSourceCachePayload = {
  version: typeof MUSIC_SOURCE_CACHE_VERSION;
  candidates: CachedMusicCandidate[];
};

export function encodeMusicSourceCache(candidates: Candidate[]): MusicSourceCachePayload {
  return {
    version: MUSIC_SOURCE_CACHE_VERSION,
    candidates: candidates.map((candidate) => ({
      uri: candidate.uri,
      title: candidate.title,
      subtitle: candidate.subtitle ?? null,
      durationMs: candidate.durationMs,
    })),
  };
}

export function decodeMusicSourceCache(value: unknown): Candidate[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.version !== MUSIC_SOURCE_CACHE_VERSION) return null;
  if (!Array.isArray(payload.candidates)) return null;

  const candidates: Candidate[] = [];
  for (const item of payload.candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.uri !== "string" ||
      typeof candidate.title !== "string" ||
      typeof candidate.durationMs !== "number" ||
      !Number.isFinite(candidate.durationMs) ||
      candidate.durationMs < 0 ||
      !(
        candidate.subtitle === null ||
        candidate.subtitle === undefined ||
        typeof candidate.subtitle === "string"
      )
    ) {
      return null;
    }

    candidates.push({
      uri: candidate.uri,
      type: "MUSIC",
      title: candidate.title,
      ...(typeof candidate.subtitle === "string"
        ? { subtitle: candidate.subtitle }
        : {}),
      durationMs: candidate.durationMs,
    });
  }

  return candidates;
}
