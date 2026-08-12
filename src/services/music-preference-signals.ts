export type PreferenceSignalContentType = "MUSIC" | "PODCAST";

export type PublishedPreferenceItem = {
  id?: string | null;
  position: number;
  type: PreferenceSignalContentType;
  uri: string;
  spotifyTrackId?: string | null;
  durationMs: number;
};

export type TrackPlaybackObservation = {
  spotifyTrackId: string;
  lastPlayedAt: Date;
};

export type InferredSkipEvidence = {
  signalType: "INFERRED_SKIP";
  spotifyTrackId: string;
  spotifyUri: string;
  generationItemId: string | null;
  position: number;
  previousSpotifyTrackId: string;
  nextSpotifyTrackId: string;
  previousPlayedAt: Date;
  nextPlayedAt: Date;
  publishedAt: Date;
  observedUntil: Date;
  plannedCorridorDurationMs: number;
  observedGapMs: number;
  continuityToleranceMs: number;
  confidence: number;
};

export type InferSingleTrackSkipsInput = {
  /** Final applied GenerationItem order, including podcasts between music slots. */
  items: PublishedPreferenceItem[];
  /** Conservative lower bound: use the completed timestamp of the applied run. */
  publishedAt: Date;
  /** Upper bound captured immediately after the existing MUSIC-01 history sync. */
  observedUntil: Date;
  /** MUSIC-01 last-known playback state for identities present in the generation. */
  observations: TrackPlaybackObservation[];
  /** Pause/jitter budget above the planned corridor duration. */
  continuityToleranceMs?: number;
};

/**
 * MUSIC-05 deliberately requires stronger evidence than "track not observed".
 *
 * A track is an inferred skip only when it is the single missing MUSIC item
 * between two observed MUSIC items in the final published order. The previous
 * and next observations must be chronological and close enough to fit the
 * planned content corridor plus a small tolerance. This prevents a stopped
 * session that resumes hours/days later from looking like a skip.
 *
 * The function is pure: it performs no Spotify calls and never mutates
 * TrackListeningState. Persistence/consumption belongs to orchestration.
 */
export function inferSingleTrackSkips({
  items,
  publishedAt,
  observedUntil,
  observations,
  continuityToleranceMs = 5 * 60_000,
}: InferSingleTrackSkipsInput): InferredSkipEvidence[] {
  if (observedUntil <= publishedAt) return [];
  if (!Number.isFinite(continuityToleranceMs) || continuityToleranceMs < 0) {
    throw new Error("continuityToleranceMs must be a non-negative finite number");
  }

  const ordered = [...items].sort((left, right) => left.position - right.position);
  const latestPlayedAt = new Map<string, Date>();
  for (const observation of observations) {
    if (!observation.spotifyTrackId) continue;
    const existing = latestPlayedAt.get(observation.spotifyTrackId);
    if (!existing || observation.lastPlayedAt > existing) {
      latestPlayedAt.set(observation.spotifyTrackId, observation.lastPlayedAt);
    }
  }

  const music = ordered
    .map((item, orderedIndex) => ({ item, orderedIndex }))
    .filter(({ item }) => item.type === "MUSIC");
  const inferred: InferredSkipEvidence[] = [];

  for (let index = 1; index < music.length - 1; index += 1) {
    const previous = music[index - 1]!;
    const candidate = music[index]!;
    const next = music[index + 1]!;

    const previousId = stableTrackId(previous.item);
    const candidateId = stableTrackId(candidate.item);
    const nextId = stableTrackId(next.item);
    if (!previousId || !candidateId || !nextId) continue;

    const previousPlayedAt = playedWithinWindow(
      latestPlayedAt.get(previousId),
      publishedAt,
      observedUntil,
    );
    const candidatePlayedAt = playedWithinWindow(
      latestPlayedAt.get(candidateId),
      publishedAt,
      observedUntil,
    );
    const nextPlayedAt = playedWithinWindow(
      latestPlayedAt.get(nextId),
      publishedAt,
      observedUntil,
    );

    if (!previousPlayedAt || candidatePlayedAt || !nextPlayedAt) continue;
    if (previousPlayedAt >= nextPlayedAt) continue;

    const plannedCorridorDurationMs = ordered
      .slice(previous.orderedIndex, next.orderedIndex)
      .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
    const observedGapMs = nextPlayedAt.getTime() - previousPlayedAt.getTime();
    if (observedGapMs > plannedCorridorDurationMs + continuityToleranceMs) {
      continue;
    }

    inferred.push({
      signalType: "INFERRED_SKIP",
      spotifyTrackId: candidateId,
      spotifyUri: candidate.item.uri,
      generationItemId: candidate.item.id ?? null,
      position: candidate.item.position,
      previousSpotifyTrackId: previousId,
      nextSpotifyTrackId: nextId,
      previousPlayedAt,
      nextPlayedAt,
      publishedAt,
      observedUntil,
      plannedCorridorDurationMs,
      observedGapMs,
      continuityToleranceMs,
      // Deliberately below 1.0: Recently Played has no playlist-context field.
      confidence: 0.9,
    });
  }

  return inferred;
}

function stableTrackId(item: PublishedPreferenceItem): string | null {
  const value = item.spotifyTrackId?.trim();
  return value ? value : null;
}

function playedWithinWindow(
  value: Date | undefined,
  publishedAt: Date,
  observedUntil: Date,
): Date | null {
  if (!value) return null;
  return value > publishedAt && value <= observedUntil ? value : null;
}
