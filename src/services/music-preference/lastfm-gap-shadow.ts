import type {
  LastFmCoverageAssessment,
  LastFmOccurrenceMatch,
  LastFmCoverageWindow,
} from "./lastfm-coverage";

export const MUSIC_06_LASTFM_GAP_METHOD =
  "LASTFM_PLANNED_SEQUENCE_GAP" as const;

/**
 * Gate 3 shadow-only confidence. This is intentionally conservative and is not
 * a calibrated behavioral probability. Gate 3 measures candidate quality before
 * any productive weighting is allowed.
 */
export const MUSIC_06_LASTFM_GAP_SHADOW_CONFIDENCE = 0.9;

export type Music06LastFmGapShadowEvidence = Readonly<{
  evidenceLevel: "INFERRED";
  evidenceMethod: typeof MUSIC_06_LASTFM_GAP_METHOD;
  confidence: number;
  generationRunId: string;
  targetPlaylistId: string;
  generationItemId: string;
  position: number;
  trackName: string | null;
  artistName: string | null;
  /** Operational identity reference only; the behavioral evidence is Last.fm. */
  spotifyTrackId: string | null;
  previousGenerationItemId: string;
  previousPosition: number;
  previousPlayedAt: Date;
  nextGenerationItemId: string;
  nextPosition: number;
  nextPlayedAt: Date;
  reason: "EVALUABLE_UNIT_GAP_WITH_LASTFM_ANCHORS";
}>;

export type Music06LastFmGapShadowResult = Readonly<{
  mode: "SHADOW_READ_ONLY";
  assessedWindowCount: number;
  inferredGapCount: number;
  gaps: readonly Music06LastFmGapShadowEvidence[];
}>;

/**
 * MUSIC-06 Gate 3 detector.
 *
 * It consumes only Gate 2 coverage output. A gap is emitted when:
 * - the center window is explicitly evaluable;
 * - the center occurrence is UNMATCHED;
 * - previous and next occurrences are uniquely matched Last.fm anchors;
 * - the anchor timestamps are present and chronological.
 *
 * The function is pure and does not write MusicPreferenceSignal, playlists or
 * any database state.
 */
export function inferMusic06LastFmGapShadow(
  assessment: LastFmCoverageAssessment,
): Music06LastFmGapShadowResult {
  const matchByItemId = new Map(
    assessment.matches.map((match) => [
      match.occurrence.generationItemId,
      match,
    ] as const),
  );
  const gaps: Music06LastFmGapShadowEvidence[] = [];

  for (const window of assessment.windows) {
    if (!window.evaluable) continue;

    const previous = matchByItemId.get(window.previousGenerationItemId);
    const center = matchByItemId.get(window.centerGenerationItemId);
    const next = matchByItemId.get(window.nextGenerationItemId);

    if (!previous || !center || !next) continue;
    if (!isMatchedAnchor(previous) || !isMatchedAnchor(next)) continue;
    if (center.status !== "UNMATCHED") continue;

    const previousPlayedAt = previous.scrobble.playedAt;
    const nextPlayedAt = next.scrobble.playedAt;
    if (previousPlayedAt >= nextPlayedAt) continue;

    gaps.push({
      evidenceLevel: "INFERRED",
      evidenceMethod: MUSIC_06_LASTFM_GAP_METHOD,
      confidence: MUSIC_06_LASTFM_GAP_SHADOW_CONFIDENCE,
      generationRunId: center.occurrence.generationRunId,
      targetPlaylistId: center.occurrence.targetPlaylistId,
      generationItemId: center.occurrence.generationItemId,
      position: center.occurrence.position,
      trackName: center.occurrence.trackName,
      artistName: center.occurrence.artistName,
      spotifyTrackId: center.occurrence.spotifyTrackId,
      previousGenerationItemId: previous.occurrence.generationItemId,
      previousPosition: previous.occurrence.position,
      previousPlayedAt,
      nextGenerationItemId: next.occurrence.generationItemId,
      nextPosition: next.occurrence.position,
      nextPlayedAt,
      reason: "EVALUABLE_UNIT_GAP_WITH_LASTFM_ANCHORS",
    });
  }

  return {
    mode: "SHADOW_READ_ONLY",
    assessedWindowCount: assessment.windows.filter((window) => window.evaluable)
      .length,
    inferredGapCount: gaps.length,
    gaps,
  };
}

function isMatchedAnchor(
  match: LastFmOccurrenceMatch,
): match is LastFmOccurrenceMatch & { scrobble: NonNullable<LastFmOccurrenceMatch["scrobble"]> } {
  return match.status === "MATCHED" && match.scrobble !== null;
}
