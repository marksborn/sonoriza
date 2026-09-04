import { normalizeMusicIdentityText } from "./lastfm-coverage";
import type { Music06LastFmGapReport } from "./lastfm-gap-shadow-report";

export const MUSIC_06_NEGATIVE_PROJECTION_IDENTITY_METHOD =
  "TRACK_ARTIST_NORMALIZED_EXACT" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Music06RateWindow = Readonly<{
  assessedOccurrenceCount: number;
  negativeOccurrenceCount: number;
  skipRate: number | null;
}>;

export type Music06TrackNegativeProjection = Readonly<{
  trackKey: string;
  identityMethod: typeof MUSIC_06_NEGATIVE_PROJECTION_IDENTITY_METHOD;
  trackName: string;
  artistName: string;
  assessedOccurrenceCount: number;
  inferredSkipCount: number;
  negativeSignalCount: number;
  skipRate: number;
  recent30d: Music06RateWindow;
  recent90d: Music06RateWindow;
  recent30dSkipRate: number | null;
  recent90dSkipRate: number | null;
  lastNegativeAt: Date | null;
  distinctNegativeDays: number;
}>;

export type Music06ArtistNegativeProjection = Readonly<{
  artistKey: string;
  identityMethod: typeof MUSIC_06_NEGATIVE_PROJECTION_IDENTITY_METHOD;
  artistName: string;
  assessedOccurrenceCount: number;
  negativeOccurrenceCount: number;
  inferredSkipCount: number;
  negativeSignalCount: number;
  skipRate: number;
  recent30d: Music06RateWindow;
  recent90d: Music06RateWindow;
  recent30dSkipRate: number | null;
  recent90dSkipRate: number | null;
  distinctTracksAssessed: number;
  distinctTracksNegative: number;
  distinctNegativeDays: number;
  lastNegativeAt: Date | null;
}>;

export type Music06NegativeProjectionShadow = Readonly<{
  mode: "SHADOW_READ_ONLY";
  asOf: Date;
  sourceReportCount: number;
  assessedOccurrenceCount: number;
  negativeOccurrenceCount: number;
  duplicateOccurrenceCount: number;
  conflictingOccurrenceCount: number;
  unprojectableOccurrenceCount: number;
  tracks: readonly Music06TrackNegativeProjection[];
  artists: readonly Music06ArtistNegativeProjection[];
}>;

type AssessedOccurrence = Readonly<{
  occurrenceKey: string;
  generationRunId: string;
  targetPlaylistId: string;
  generationItemId: string;
  trackKey: string;
  artistKey: string;
  trackName: string;
  artistName: string;
  assessedAt: Date;
  negative: boolean;
  negativeAt: Date | null;
}>;

type MutableTrackProjection = {
  trackKey: string;
  trackName: string;
  artistName: string;
  occurrences: AssessedOccurrence[];
};

type MutableArtistProjection = {
  artistKey: string;
  artistName: string;
  occurrences: AssessedOccurrence[];
};

/**
 * MUSIC-06 Gate 4 shadow projection.
 *
 * Only Gate 3 reports are accepted as input. The projector never reads Spotify,
 * never writes Prisma state and never influences the planner. Its denominator is
 * limited to center occurrences whose Gate 2 coverage window was explicitly
 * evaluable under CONFIRMED Last.fm coverage.
 */
export function projectMusic06NegativeShadow(input: {
  reports: readonly Music06LastFmGapReport[];
  asOf: Date;
}): Music06NegativeProjectionShadow {
  assertValidDate(input.asOf, "asOf");

  const extracted = extractAssessedOccurrences(input.reports, input.asOf);
  const trackGroups = new Map<string, MutableTrackProjection>();
  const artistGroups = new Map<string, MutableArtistProjection>();

  for (const occurrence of extracted.occurrences) {
    const track = trackGroups.get(occurrence.trackKey) ?? {
      trackKey: occurrence.trackKey,
      trackName: occurrence.trackName,
      artistName: occurrence.artistName,
      occurrences: [],
    };
    track.occurrences.push(occurrence);
    trackGroups.set(occurrence.trackKey, track);

    const artist = artistGroups.get(occurrence.artistKey) ?? {
      artistKey: occurrence.artistKey,
      artistName: occurrence.artistName,
      occurrences: [],
    };
    artist.occurrences.push(occurrence);
    artistGroups.set(occurrence.artistKey, artist);
  }

  const tracks = [...trackGroups.values()]
    .map((group) => buildTrackProjection(group, input.asOf))
    .sort(compareTrackProjection);
  const artists = [...artistGroups.values()]
    .map((group) => buildArtistProjection(group, input.asOf))
    .sort(compareArtistProjection);

  return {
    mode: "SHADOW_READ_ONLY",
    asOf: new Date(input.asOf.getTime()),
    sourceReportCount: input.reports.length,
    assessedOccurrenceCount: extracted.occurrences.length,
    negativeOccurrenceCount: extracted.occurrences.filter((row) => row.negative)
      .length,
    duplicateOccurrenceCount: extracted.duplicateOccurrenceCount,
    conflictingOccurrenceCount: extracted.conflictingOccurrenceCount,
    unprojectableOccurrenceCount: extracted.unprojectableOccurrenceCount,
    tracks,
    artists,
  };
}

function extractAssessedOccurrences(
  reports: readonly Music06LastFmGapReport[],
  asOf: Date,
): {
  occurrences: AssessedOccurrence[];
  duplicateOccurrenceCount: number;
  conflictingOccurrenceCount: number;
  unprojectableOccurrenceCount: number;
} {
  const byOccurrence = new Map<string, AssessedOccurrence | null>();
  let duplicateOccurrenceCount = 0;
  let unprojectableOccurrenceCount = 0;
  const conflicts = new Set<string>();

  for (const report of reports) {
    const gapTargetById = new Map(
      report.targets.map((target) => [target.targetPlaylistId, target] as const),
    );

    for (const coverageTarget of report.coverage.targets) {
      const assessment = coverageTarget.assessment;
      if (assessment.status !== "CONFIRMED") continue;

      const gapTarget = gapTargetById.get(coverageTarget.targetPlaylistId);
      if (!gapTarget || gapTarget.coverageStatus !== "CONFIRMED") continue;

      const matchByItemId = new Map(
        assessment.matches.map((match) => [
          match.occurrence.generationItemId,
          match,
        ] as const),
      );
      const gapByItemId = new Map(
        gapTarget.shadow.gaps.map((gap) => [gap.generationItemId, gap] as const),
      );

      for (const window of assessment.windows) {
        if (!window.evaluable) continue;
        const center = matchByItemId.get(window.centerGenerationItemId);
        if (!center) {
          unprojectableOccurrenceCount += 1;
          continue;
        }

        const gap = gapByItemId.get(window.centerGenerationItemId) ?? null;
        const negative = gap !== null;
        const assessedAt = negative
          ? gap.nextPlayedAt
          : center.status === "MATCHED" && center.scrobble
            ? center.scrobble.playedAt
            : null;
        if (!assessedAt || assessedAt > asOf) {
          unprojectableOccurrenceCount += 1;
          continue;
        }

        const trackName = cleanDisplay(center.occurrence.trackName);
        const artistName = cleanDisplay(center.occurrence.artistName);
        const normalizedTrack = normalizeMusicIdentityText(trackName);
        const normalizedArtist = normalizeMusicIdentityText(artistName);
        if (!trackName || !artistName || !normalizedTrack || !normalizedArtist) {
          unprojectableOccurrenceCount += 1;
          continue;
        }

        const occurrence: AssessedOccurrence = {
          occurrenceKey: `${center.occurrence.generationRunId}\u0000${center.occurrence.targetPlaylistId}\u0000${center.occurrence.generationItemId}`,
          generationRunId: center.occurrence.generationRunId,
          targetPlaylistId: center.occurrence.targetPlaylistId,
          generationItemId: center.occurrence.generationItemId,
          trackKey: `${normalizedArtist}\u0000${normalizedTrack}`,
          artistKey: normalizedArtist,
          trackName,
          artistName,
          assessedAt: new Date(assessedAt.getTime()),
          negative,
          negativeAt: negative ? new Date(assessedAt.getTime()) : null,
        };

        if (!byOccurrence.has(occurrence.occurrenceKey)) {
          byOccurrence.set(occurrence.occurrenceKey, occurrence);
          continue;
        }

        duplicateOccurrenceCount += 1;
        const existing = byOccurrence.get(occurrence.occurrenceKey);
        if (existing && sameOccurrence(existing, occurrence)) continue;

        byOccurrence.set(occurrence.occurrenceKey, null);
        conflicts.add(occurrence.occurrenceKey);
      }
    }
  }

  return {
    occurrences: [...byOccurrence.values()].flatMap((row) => (row ? [row] : [])),
    duplicateOccurrenceCount,
    conflictingOccurrenceCount: conflicts.size,
    unprojectableOccurrenceCount,
  };
}

function buildTrackProjection(
  group: MutableTrackProjection,
  asOf: Date,
): Music06TrackNegativeProjection {
  const negative = group.occurrences.filter((row) => row.negative);
  const recent30d = buildRateWindow(group.occurrences, asOf, 30);
  const recent90d = buildRateWindow(group.occurrences, asOf, 90);
  return {
    trackKey: group.trackKey,
    identityMethod: MUSIC_06_NEGATIVE_PROJECTION_IDENTITY_METHOD,
    trackName: group.trackName,
    artistName: group.artistName,
    assessedOccurrenceCount: group.occurrences.length,
    inferredSkipCount: negative.length,
    negativeSignalCount: negative.length,
    skipRate: ratio(negative.length, group.occurrences.length) ?? 0,
    recent30d,
    recent90d,
    recent30dSkipRate: recent30d.skipRate,
    recent90dSkipRate: recent90d.skipRate,
    lastNegativeAt: latestNegativeAt(negative),
    distinctNegativeDays: distinctNegativeDays(negative),
  };
}

function buildArtistProjection(
  group: MutableArtistProjection,
  asOf: Date,
): Music06ArtistNegativeProjection {
  const negative = group.occurrences.filter((row) => row.negative);
  const recent30d = buildRateWindow(group.occurrences, asOf, 30);
  const recent90d = buildRateWindow(group.occurrences, asOf, 90);
  return {
    artistKey: group.artistKey,
    identityMethod: MUSIC_06_NEGATIVE_PROJECTION_IDENTITY_METHOD,
    artistName: group.artistName,
    assessedOccurrenceCount: group.occurrences.length,
    negativeOccurrenceCount: negative.length,
    inferredSkipCount: negative.length,
    negativeSignalCount: negative.length,
    skipRate: ratio(negative.length, group.occurrences.length) ?? 0,
    recent30d,
    recent90d,
    recent30dSkipRate: recent30d.skipRate,
    recent90dSkipRate: recent90d.skipRate,
    distinctTracksAssessed: new Set(group.occurrences.map((row) => row.trackKey)).size,
    distinctTracksNegative: new Set(negative.map((row) => row.trackKey)).size,
    distinctNegativeDays: distinctNegativeDays(negative),
    lastNegativeAt: latestNegativeAt(negative),
  };
}

function buildRateWindow(
  occurrences: readonly AssessedOccurrence[],
  asOf: Date,
  days: number,
): Music06RateWindow {
  const cutoff = new Date(asOf.getTime() - days * DAY_MS);
  const assessed = occurrences.filter(
    (row) => row.assessedAt >= cutoff && row.assessedAt <= asOf,
  );
  const negative = assessed.filter((row) => row.negative);
  return {
    assessedOccurrenceCount: assessed.length,
    negativeOccurrenceCount: negative.length,
    skipRate: ratio(negative.length, assessed.length),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function latestNegativeAt(
  rows: readonly AssessedOccurrence[],
): Date | null {
  const timestamps = rows.flatMap((row) =>
    row.negativeAt ? [row.negativeAt.getTime()] : [],
  );
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
}

function distinctNegativeDays(rows: readonly AssessedOccurrence[]): number {
  return new Set(
    rows.flatMap((row) =>
      row.negativeAt ? [row.negativeAt.toISOString().slice(0, 10)] : [],
    ),
  ).size;
}

function sameOccurrence(
  left: AssessedOccurrence,
  right: AssessedOccurrence,
): boolean {
  return (
    left.trackKey === right.trackKey &&
    left.artistKey === right.artistKey &&
    left.negative === right.negative &&
    left.assessedAt.getTime() === right.assessedAt.getTime()
  );
}

function cleanDisplay(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function compareTrackProjection(
  left: Music06TrackNegativeProjection,
  right: Music06TrackNegativeProjection,
): number {
  return (
    right.negativeSignalCount - left.negativeSignalCount ||
    right.skipRate - left.skipRate ||
    right.assessedOccurrenceCount - left.assessedOccurrenceCount ||
    left.artistName.localeCompare(right.artistName) ||
    left.trackName.localeCompare(right.trackName)
  );
}

function compareArtistProjection(
  left: Music06ArtistNegativeProjection,
  right: Music06ArtistNegativeProjection,
): number {
  return (
    right.negativeSignalCount - left.negativeSignalCount ||
    right.skipRate - left.skipRate ||
    right.assessedOccurrenceCount - left.assessedOccurrenceCount ||
    left.artistName.localeCompare(right.artistName)
  );
}

function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-06 negative projection requires valid ${label}`);
  }
}
