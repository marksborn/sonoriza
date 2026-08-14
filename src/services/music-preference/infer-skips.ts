/**
 * MUSIC-05 — conservative inferred-skip detection.
 *
 * Pure logic: given the applied order of one real generation (ORDER-01's
 * persisted `GenerationItem.position`) and the canonical observed plays already
 * collected by MUSIC-01, infer that a music track was skipped when the strong
 * unit-hole pattern holds:
 *
 *   previous music observed -> candidate music NOT observed -> next music observed
 *
 * The detector never consults the live player and never asserts a play. It is
 * deliberately an inference, kept minimal in v1:
 *   - only the MUSIC subsequence is evaluated (podcasts are dropped, not holes);
 *   - only unit holes are inferred (blocks with >1 missing track are ignored);
 *   - prefixes/suffixes are never skips (a session can simply start or stop);
 *   - the most-recent observed play is never conclusive as an anchor
 *     (Recently Played stabilization);
 *   - anchors must be temporally coherent (previous before next);
 *   - a candidate without a stable Spotify id is never inferred by name.
 */

export type PlannedGenerationItem = {
  position: number;
  contentType: "MUSIC" | "PODCAST";
  spotifyTrackId: string | null;
  spotifyUri: string | null;
  generationItemId?: string | null;
};

export type ObservedPlay = {
  spotifyTrackId: string;
  playedAt: Date;
};

export type InferredSkipEvidence = {
  previousTrackId: string;
  previousPlayedAt: string;
  nextTrackId: string;
  nextPlayedAt: string;
  previousPosition: number;
  position: number;
  nextPosition: number;
};

export type InferredSkip = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  position: number;
  generationItemId: string | null;
  confidence: number;
  evidence: InferredSkipEvidence;
};

export type InferInferredSkipsInput = {
  /** Every item of the applied generation, in any order (sorted internally). */
  orderedItems: readonly PlannedGenerationItem[];
  /** Canonical observed plays (e.g. from TrackListeningEvent). */
  plays: readonly ObservedPlay[];
  /**
   * The single most-recent observed play in the current Recently Played read.
   * It is never conclusive in this collection: it cannot anchor a skip and it
   * cannot consolidate a play. When a newer play arrives later, this same play
   * stops being the edge and can be processed normally.
   */
  latestObservedPlay?: ObservedPlay | null;
  /**
   * When the analyzed generation was applied. Plays before it belong to an
   * earlier listening window and never anchor this generation's inference.
   */
  generationAppliedAt: Date;
};

export type InferInferredSkipsResult = {
  inferredSkips: InferredSkip[];
  /** Track whose most-recent play was set aside by the stabilization rule. */
  deferredEdgeTrackId: string | null;
  musicSubsequenceLength: number;
};

function stableTrackId(item: PlannedGenerationItem): string | null {
  if (item.contentType !== "MUSIC") return null;
  const id = item.spotifyTrackId?.trim();
  return id ? id : null;
}

export function inferInferredSkips(
  input: InferInferredSkipsInput,
): InferInferredSkipsResult {
  const appliedAtMs = input.generationAppliedAt.getTime();
  const edge = input.latestObservedPlay ?? null;
  const edgeMs = edge ? edge.playedAt.getTime() : null;

  const isEdgePlay = (trackId: string, playedAtMs: number): boolean =>
    edge !== null &&
    edgeMs !== null &&
    trackId === edge.spotifyTrackId &&
    playedAtMs === edgeMs;

  // Plays within this generation's window, grouped by track and sorted ascending.
  const playsByTrack = new Map<string, number[]>();
  for (const play of input.plays) {
    const playedAtMs = play.playedAt.getTime();
    if (!Number.isFinite(playedAtMs) || playedAtMs < appliedAtMs) continue;
    const list = playsByTrack.get(play.spotifyTrackId);
    if (list) list.push(playedAtMs);
    else playsByTrack.set(play.spotifyTrackId, [playedAtMs]);
  }
  for (const list of playsByTrack.values()) list.sort((a, b) => a - b);

  // Earliest play usable as a positive anchor (excludes the inconclusive edge).
  const earliestAnchor = (trackId: string, afterMs: number): number | null => {
    for (const playedAtMs of playsByTrack.get(trackId) ?? []) {
      if (playedAtMs <= afterMs) continue;
      if (isEdgePlay(trackId, playedAtMs)) continue;
      return playedAtMs;
    }
    return null;
  };
  const firstAnchor = (trackId: string): number | null => {
    for (const playedAtMs of playsByTrack.get(trackId) ?? []) {
      if (isEdgePlay(trackId, playedAtMs)) continue;
      return playedAtMs;
    }
    return null;
  };
  const playedBetween = (
    trackId: string,
    lowMs: number,
    highMs: number,
  ): boolean =>
    (playsByTrack.get(trackId) ?? []).some(
      (playedAtMs) => playedAtMs >= lowMs && playedAtMs <= highMs,
    );

  const musicSubsequence = [...input.orderedItems]
    .sort((a, b) => a.position - b.position)
    .filter((item) => item.contentType === "MUSIC");

  const inferredSkips: InferredSkip[] = [];
  let deferredEdgeTrackId: string | null = null;

  for (let j = 1; j < musicSubsequence.length - 1; j += 1) {
    const previous = musicSubsequence[j - 1]!;
    const candidate = musicSubsequence[j]!;
    const next = musicSubsequence[j + 1]!;

    const candidateId = stableTrackId(candidate);
    const previousId = stableTrackId(previous);
    const nextId = stableTrackId(next);
    // A candidate/anchor without a stable identity is never inferred by name.
    if (!candidateId || !previousId || !nextId) continue;

    const previousAnchorMs = firstAnchor(previousId);
    if (previousAnchorMs === null) continue;

    const nextAnchorMs = earliestAnchor(nextId, previousAnchorMs);
    if (nextAnchorMs === null) {
      // If the only continuity play for `next` was the inconclusive edge, the
      // decision is deferred to a later read rather than inferred prematurely.
      const nextHasEdgeOnly =
        edge !== null &&
        nextId === edge.spotifyTrackId &&
        (playsByTrack.get(nextId) ?? []).some(
          (playedAtMs) =>
            playedAtMs > previousAnchorMs && isEdgePlay(nextId, playedAtMs),
        );
      if (nextHasEdgeOnly) deferredEdgeTrackId = nextId;
      continue;
    }

    // The candidate must have no observed play inside the continuity window.
    if (playedBetween(candidateId, previousAnchorMs, nextAnchorMs)) continue;

    inferredSkips.push({
      spotifyTrackId: candidateId,
      spotifyUri: candidate.spotifyUri,
      position: candidate.position,
      generationItemId: candidate.generationItemId ?? null,
      confidence: 1,
      evidence: {
        previousTrackId: previousId,
        previousPlayedAt: new Date(previousAnchorMs).toISOString(),
        nextTrackId: nextId,
        nextPlayedAt: new Date(nextAnchorMs).toISOString(),
        previousPosition: previous.position,
        position: candidate.position,
        nextPosition: next.position,
      },
    });
  }

  return {
    inferredSkips,
    deferredEdgeTrackId,
    musicSubsequenceLength: musicSubsequence.length,
  };
}
