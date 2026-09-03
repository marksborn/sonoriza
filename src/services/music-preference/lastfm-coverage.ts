import type { LastFmListeningEventInput } from "@/services/lastfm/client";

export const LASTFM_COVERAGE_STATUSES = [
  "CONFIRMED",
  "PARTIAL",
  "UNKNOWN",
  "UNAVAILABLE",
] as const;

export type LastFmCoverageStatus =
  (typeof LASTFM_COVERAGE_STATUSES)[number];

export const LASTFM_OCCURRENCE_MATCH_STATUSES = [
  "MATCHED",
  "UNMATCHED",
  "AMBIGUOUS",
  "UNMATCHABLE",
] as const;

export type LastFmOccurrenceMatchStatus =
  (typeof LASTFM_OCCURRENCE_MATCH_STATUSES)[number];

export const LASTFM_OCCURRENCE_MATCH_BASIS =
  "TRACK_ARTIST_NORMALIZED_EXACT" as const;

export type PublishedMusicOccurrence = Readonly<{
  generationRunId: string;
  targetPlaylistId: string;
  generationItemId: string;
  position: number;
  publishedAt: Date;
  trackName: string | null;
  artistName: string | null;
  /** Operational provider reference only; never Last.fm behavioral evidence. */
  spotifyTrackId: string | null;
}>;

export type LastFmRecentObservation = Readonly<{
  username: string;
  observedAt: Date;
  requestedFrom: Date;
  requestedTo: Date;
  pagesFetched: number;
  totalPages: number;
  providerTotal: number;
  complete: boolean;
  nowPlayingCount: number;
  invalidCount: number;
  scrobbles: readonly LastFmListeningEventInput[];
}>;

export type LastFmOccurrenceMatch = Readonly<{
  occurrence: PublishedMusicOccurrence;
  status: LastFmOccurrenceMatchStatus;
  basis: typeof LASTFM_OCCURRENCE_MATCH_BASIS | null;
  scrobble: LastFmListeningEventInput | null;
  reason:
    | "MATCHED_UNIQUE_TRACK_ARTIST"
    | "NO_MATCHING_SCROBBLE"
    | "DUPLICATE_PUBLISHED_IDENTITY"
    | "MULTIPLE_MATCHING_SCROBBLES"
    | "MISSING_PUBLISHED_IDENTITY";
}>;

export type LastFmCoverageWindow = Readonly<{
  targetPlaylistId: string;
  previousGenerationItemId: string;
  centerGenerationItemId: string;
  nextGenerationItemId: string;
  previousPosition: number;
  centerPosition: number;
  nextPosition: number;
  evaluable: boolean;
  reasons: readonly string[];
  previousPlayedAt: Date | null;
  centerPlayedAt: Date | null;
  nextPlayedAt: Date | null;
}>;

export type LastFmCoverageAssessment = Readonly<{
  status: LastFmCoverageStatus;
  reasons: readonly string[];
  publishedOccurrenceCount: number;
  matchedOccurrenceCount: number;
  unmatchedOccurrenceCount: number;
  ambiguousOccurrenceCount: number;
  unmatchableOccurrenceCount: number;
  evaluableWindowCount: number;
  windows: readonly LastFmCoverageWindow[];
  matches: readonly LastFmOccurrenceMatch[];
}>;

/**
 * MUSIC-06 Gate 2 identity matcher.
 *
 * This matcher is deliberately conservative. It never calls Spotify and never
 * performs fuzzy catalog resolution. A published identity is matched only when
 * normalized track+artist is unique in both the published sequence and the
 * Last.fm observation window. Repeated/ambiguous identities abstain so Gate 3
 * cannot turn an uncertain alignment into negative behavioral evidence.
 */
export function matchPublishedOccurrencesToLastFm(input: {
  occurrences: readonly PublishedMusicOccurrence[];
  scrobbles: readonly LastFmListeningEventInput[];
}): LastFmOccurrenceMatch[] {
  const occurrenceKeyCounts = countKeys(
    input.occurrences.map((occurrence) => occurrenceIdentityKey(occurrence)),
  );
  const scrobblesByKey = new Map<string, LastFmListeningEventInput[]>();

  for (const scrobble of input.scrobbles) {
    const key = scrobbleIdentityKey(scrobble);
    if (!key) continue;
    const rows = scrobblesByKey.get(key);
    if (rows) rows.push(scrobble);
    else scrobblesByKey.set(key, [scrobble]);
  }

  for (const rows of scrobblesByKey.values()) {
    rows.sort((left, right) => left.playedAt.getTime() - right.playedAt.getTime());
  }

  return [...input.occurrences]
    .sort((left, right) => left.position - right.position)
    .map((occurrence) => {
      const key = occurrenceIdentityKey(occurrence);
      if (!key) {
        return {
          occurrence,
          status: "UNMATCHABLE",
          basis: null,
          scrobble: null,
          reason: "MISSING_PUBLISHED_IDENTITY",
        } satisfies LastFmOccurrenceMatch;
      }

      if ((occurrenceKeyCounts.get(key) ?? 0) > 1) {
        return {
          occurrence,
          status: "AMBIGUOUS",
          basis: LASTFM_OCCURRENCE_MATCH_BASIS,
          scrobble: null,
          reason: "DUPLICATE_PUBLISHED_IDENTITY",
        } satisfies LastFmOccurrenceMatch;
      }

      const candidates = scrobblesByKey.get(key) ?? [];
      if (candidates.length === 0) {
        return {
          occurrence,
          status: "UNMATCHED",
          basis: LASTFM_OCCURRENCE_MATCH_BASIS,
          scrobble: null,
          reason: "NO_MATCHING_SCROBBLE",
        } satisfies LastFmOccurrenceMatch;
      }
      if (candidates.length > 1) {
        return {
          occurrence,
          status: "AMBIGUOUS",
          basis: LASTFM_OCCURRENCE_MATCH_BASIS,
          scrobble: null,
          reason: "MULTIPLE_MATCHING_SCROBBLES",
        } satisfies LastFmOccurrenceMatch;
      }

      return {
        occurrence,
        status: "MATCHED",
        basis: LASTFM_OCCURRENCE_MATCH_BASIS,
        scrobble: candidates[0]!,
        reason: "MATCHED_UNIQUE_TRACK_ARTIST",
      } satisfies LastFmOccurrenceMatch;
    });
}

/**
 * Coverage here means "is this published occurrence window safe to evaluate?"
 * It does NOT mean the center item was skipped. Gate 2 only measures coverage.
 * Gate 3 may later interpret an evaluable center absence as one ingredient of
 * LASTFM_PLANNED_SEQUENCE_GAP.
 */
export function assessLastFmCoverage(input: {
  occurrences: readonly PublishedMusicOccurrence[];
  observation: LastFmRecentObservation | null;
  unavailableReason?: string | null;
}): LastFmCoverageAssessment {
  const occurrences = [...input.occurrences].sort(
    (left, right) => left.position - right.position,
  );

  if (!input.observation) {
    const matches = matchPublishedOccurrencesToLastFm({
      occurrences,
      scrobbles: [],
    });
    return summarizeCoverage({
      status: "UNAVAILABLE",
      reasons: [input.unavailableReason?.trim() || "LASTFM_UNAVAILABLE"],
      matches,
      windows: buildCoverageWindows(matches, [], false),
    });
  }

  const observation = input.observation;
  const matches = matchPublishedOccurrencesToLastFm({
    occurrences,
    scrobbles: observation.scrobbles,
  });
  const windows = buildCoverageWindows(
    matches,
    observation.scrobbles,
    observation.complete,
  );
  const evaluableWindowCount = windows.filter((window) => window.evaluable).length;

  if (!observation.complete) {
    return summarizeCoverage({
      status: "PARTIAL",
      reasons: ["LASTFM_PAGINATION_INCOMPLETE"],
      matches,
      windows,
    });
  }

  if (evaluableWindowCount === 0) {
    const reasons: string[] = ["NO_EVALUABLE_PUBLISHED_WINDOW"];
    if (observation.scrobbles.length === 0) reasons.push("NO_COMPLETED_SCROBBLES");
    if (observation.nowPlayingCount > 0) reasons.push("NOW_PLAYING_SEEN_ONLY_OR_INSUFFICIENT");
    return summarizeCoverage({
      status: "UNKNOWN",
      reasons,
      matches,
      windows,
    });
  }

  return summarizeCoverage({
    status: "CONFIRMED",
    reasons: ["COMPLETE_LASTFM_WINDOW_WITH_ORDERED_PUBLISHED_ANCHORS"],
    matches,
    windows,
  });
}

export function normalizeMusicIdentityText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function occurrenceIdentityKey(occurrence: PublishedMusicOccurrence): string | null {
  const track = normalizeMusicIdentityText(occurrence.trackName);
  const artist = normalizeMusicIdentityText(occurrence.artistName);
  return track && artist ? `${artist}\u0000${track}` : null;
}

function scrobbleIdentityKey(scrobble: LastFmListeningEventInput): string | null {
  const track = normalizeMusicIdentityText(scrobble.trackName);
  const artist = normalizeMusicIdentityText(scrobble.artistName);
  return track && artist ? `${artist}\u0000${track}` : null;
}

function countKeys(keys: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildCoverageWindows(
  matches: readonly LastFmOccurrenceMatch[],
  scrobbles: readonly LastFmListeningEventInput[],
  observationComplete: boolean,
): LastFmCoverageWindow[] {
  const windows: LastFmCoverageWindow[] = [];

  for (let index = 1; index < matches.length - 1; index += 1) {
    const previous = matches[index - 1]!;
    const center = matches[index]!;
    const next = matches[index + 1]!;
    const reasons: string[] = [];

    if (!observationComplete) reasons.push("LASTFM_PAGINATION_INCOMPLETE");
    if (previous.status !== "MATCHED") reasons.push("PREVIOUS_ANCHOR_NOT_MATCHED");
    if (next.status !== "MATCHED") reasons.push("NEXT_ANCHOR_NOT_MATCHED");
    if (center.status === "AMBIGUOUS") reasons.push("CENTER_IDENTITY_AMBIGUOUS");
    if (center.status === "UNMATCHABLE") reasons.push("CENTER_IDENTITY_UNMATCHABLE");

    const previousPlayedAt = previous.scrobble?.playedAt ?? null;
    const centerPlayedAt = center.scrobble?.playedAt ?? null;
    const nextPlayedAt = next.scrobble?.playedAt ?? null;
    const previousPlayedAtMs = previousPlayedAt?.getTime() ?? null;
    const centerPlayedAtMs = centerPlayedAt?.getTime() ?? null;
    const nextPlayedAtMs = nextPlayedAt?.getTime() ?? null;

    if (
      previousPlayedAtMs !== null &&
      nextPlayedAtMs !== null &&
      previousPlayedAtMs >= nextPlayedAtMs
    ) {
      reasons.push("ANCHORS_NOT_CHRONOLOGICAL");
    }

    if (
      previousPlayedAtMs !== null &&
      centerPlayedAtMs !== null &&
      nextPlayedAtMs !== null &&
      !(previousPlayedAtMs < centerPlayedAtMs && centerPlayedAtMs < nextPlayedAtMs)
    ) {
      reasons.push("CENTER_SCROBBLE_OUTSIDE_ANCHORS");
    }

    if (
      previousPlayedAtMs !== null &&
      nextPlayedAtMs !== null &&
      previousPlayedAtMs < nextPlayedAtMs
    ) {
      const allowedEventKeys = new Set(
        [previous.scrobble, center.scrobble, next.scrobble]
          .flatMap((row) => (row ? [row.sourceEventKey] : [])),
      );
      const unrelatedBetween = scrobbles.some((scrobble) => {
        const playedAtMs = scrobble.playedAt.getTime();
        return (
          playedAtMs > previousPlayedAtMs &&
          playedAtMs < nextPlayedAtMs &&
          !allowedEventKeys.has(scrobble.sourceEventKey)
        );
      });
      if (unrelatedBetween) {
        reasons.push("UNPLANNED_SCROBBLE_BETWEEN_ANCHORS");
      }
    }

    windows.push({
      targetPlaylistId: center.occurrence.targetPlaylistId,
      previousGenerationItemId: previous.occurrence.generationItemId,
      centerGenerationItemId: center.occurrence.generationItemId,
      nextGenerationItemId: next.occurrence.generationItemId,
      previousPosition: previous.occurrence.position,
      centerPosition: center.occurrence.position,
      nextPosition: next.occurrence.position,
      evaluable: reasons.length === 0,
      reasons,
      previousPlayedAt,
      centerPlayedAt,
      nextPlayedAt,
    });
  }

  return windows;
}

function summarizeCoverage(input: {
  status: LastFmCoverageStatus;
  reasons: readonly string[];
  matches: readonly LastFmOccurrenceMatch[];
  windows: readonly LastFmCoverageWindow[];
}): LastFmCoverageAssessment {
  return {
    status: input.status,
    reasons: input.reasons,
    publishedOccurrenceCount: input.matches.length,
    matchedOccurrenceCount: countStatus(input.matches, "MATCHED"),
    unmatchedOccurrenceCount: countStatus(input.matches, "UNMATCHED"),
    ambiguousOccurrenceCount: countStatus(input.matches, "AMBIGUOUS"),
    unmatchableOccurrenceCount: countStatus(input.matches, "UNMATCHABLE"),
    evaluableWindowCount: input.windows.filter((window) => window.evaluable).length,
    windows: input.windows,
    matches: input.matches,
  };
}

function countStatus(
  matches: readonly LastFmOccurrenceMatch[],
  status: LastFmOccurrenceMatchStatus,
): number {
  return matches.filter((match) => match.status === status).length;
}
