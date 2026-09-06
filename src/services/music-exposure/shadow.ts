import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";

export const MUSIC_07_SHADOW_THRESHOLD_DEFAULT = 4;
export const MUSIC_07_SHADOW_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

export type MusicExposureShadowRunStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "PARTIAL"
  | "FAILED";
export type MusicExposureShadowUpdatePolicy = "REBUILD_DAILY" | "KEEP_FILLED" | "MANUAL";

export type MusicExposureShadowTrack = Readonly<{
  trackKey: string;
  trackName: string;
  artistName: string;
  position: number;
}>;

export type MusicExposureShadowPublication = Readonly<{
  runId: string;
  targetPlaylistId: string;
  targetName: string;
  updatePolicy: MusicExposureShadowUpdatePolicy;
  publishedAt: Date;
  simulation: boolean;
  status: MusicExposureShadowRunStatus;
  /** Provider write proof from the Sonoriza-owned run summary. */
  applied: boolean;
  tracks: readonly MusicExposureShadowTrack[];
}>;

export type MusicExposureShadowScrobble = Readonly<{
  playedAt: Date;
  trackName: string;
  artistName: string;
}>;

export type MusicExposureUsageEvidence =
  | "TRACK_CONSUMED"
  | "SESSION_USED_NO_TRACK_MATCH"
  | "SESSION_USAGE_UNCONFIRMED";

export type MusicExposureShadowEvent = Readonly<{
  eventKey: string;
  runId: string;
  targetPlaylistId: string;
  targetName: string;
  trackKey: string;
  trackName: string;
  artistName: string;
  position: number;
  exposedAt: Date;
  observationEndsAt: Date;
  usageEvidence: MusicExposureUsageEvidence;
  validExposure: boolean;
  confirmedConsumptionAt: Date | null;
}>;

export type MusicExposureShadowProjection = Readonly<{
  trackKey: string;
  trackName: string;
  artistName: string;
  validExposureCount: number;
  consecutiveUnconfirmedExposureCount: number;
  lastExposureAt: Date | null;
  lastConfirmedConsumptionAt: Date | null;
  thresholdReachedAt: Date | null;
  wouldEnterCooldown: boolean;
}>;

export type MusicExposureShadowTargetSummary = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  publicationCount: number;
  validExposureCount: number;
  confirmedConsumptionCount: number;
  sessionUsageUnconfirmedCount: number;
  keepFilledBaselineSkippedCount: number;
}>;

export type MusicExposureShadowReport = Readonly<{
  threshold: number;
  publicationCount: number;
  exposureCount: number;
  validExposureCount: number;
  confirmedConsumptionCount: number;
  thresholdTrackCount: number;
  uniqueExposedTrackCount: number;
  keepFilledBaselineSkippedCount: number;
  sessionUsageUnconfirmedCount: number;
  events: readonly MusicExposureShadowEvent[];
  projections: readonly MusicExposureShadowProjection[];
  targets: readonly MusicExposureShadowTargetSummary[];
}>;

/**
 * MUSIC-07 Gate 2 shadow projection.
 *
 * This module is deliberately planner-neutral: it only receives first-party
 * publication facts plus Last.fm observations and returns a report. It does not
 * mutate persistence, call Spotify, create negative preferences, or change
 * eligibility.
 *
 * Exposure semantics:
 * - REBUILD_DAILY/MANUAL: every music track in an applied real publication is
 *   considered newly presented by Sonoriza.
 * - KEEP_FILLED: only identities absent from the previous measurable final
 *   snapshot count. A real no-op snapshot may establish/update the comparison
 *   baseline, but never creates exposure because applied=false. The first
 *   measurable snapshot is baseline-only and creates no exposure.
 * - an exposure becomes operationally valid only when there is positive
 *   Last.fm evidence that at least one track from that target publication was
 *   consumed inside the observation window;
 * - a matching scrobble for the exposed track confirms consumption and resets
 *   its consecutive unconfirmed-exposure projection;
 * - absence of a scrobble never becomes negative evidence.
 */
export function buildMusicExposureShadow(input: {
  publications: readonly MusicExposureShadowPublication[];
  scrobbles: readonly MusicExposureShadowScrobble[];
  observedUntil: Date;
  threshold?: number;
  sessionWindowMs?: number;
}): MusicExposureShadowReport {
  const threshold = positiveInt(
    input.threshold ?? MUSIC_07_SHADOW_THRESHOLD_DEFAULT,
    "threshold",
  );
  const sessionWindowMs = positiveInt(
    input.sessionWindowMs ?? MUSIC_07_SHADOW_SESSION_WINDOW_MS,
    "sessionWindowMs",
  );
  assertDate(input.observedUntil, "observedUntil");

  const publications = dedupePublications(
    input.publications.filter(isMeasurablePublication).map(normalizePublication),
  ).sort(comparePublication);
  const scrobbles = [...input.scrobbles]
    .map(normalizeScrobble)
    .filter((row): row is NormalizedScrobble => row !== null)
    .sort((left, right) => left.playedAt.getTime() - right.playedAt.getTime());

  const byTarget = groupBy(publications, (row) => row.targetPlaylistId);
  const events: MusicExposureShadowEvent[] = [];
  const targetSummaries = new Map<string, MutableTargetSummary>();
  const eventKeys = new Set<string>();

  for (const targetPublications of byTarget.values()) {
    targetPublications.sort(comparePublication);
    let previousKeepFilledTrackKeys: Set<string> | null = null;

    for (let index = 0; index < targetPublications.length; index += 1) {
      const publication = targetPublications[index]!;
      const next = targetPublications[index + 1] ?? null;
      const targetSummary = targetSummaryFor(targetSummaries, publication);
      targetSummary.publicationCount += 1;

      const snapshotTracks = dedupeTracks(publication.tracks);
      const snapshotTrackKeys = new Set(snapshotTracks.map((track) => track.trackKey));
      let newlyPresented = snapshotTracks;

      if (publication.updatePolicy === "KEEP_FILLED") {
        if (previousKeepFilledTrackKeys === null) {
          previousKeepFilledTrackKeys = snapshotTrackKeys;
          targetSummary.keepFilledBaselineSkippedCount += snapshotTracks.length;
          continue;
        }
        newlyPresented = snapshotTracks.filter(
          (track) => !previousKeepFilledTrackKeys!.has(track.trackKey),
        );
        previousKeepFilledTrackKeys = snapshotTrackKeys;
      }

      // A measurable KEEP_FILLED no-op may move the baseline forward, but it is
      // never an exposure. REBUILD_DAILY/MANUAL unapplied rows are filtered out
      // before this point.
      if (!publication.applied || newlyPresented.length === 0) continue;

      const windowEnd = minDate(
        input.observedUntil,
        new Date(publication.publishedAt.getTime() + sessionWindowMs),
        next?.publishedAt ?? input.observedUntil,
      );
      if (windowEnd <= publication.publishedAt) continue;

      const scrobblesInWindow = scrobbles.filter(
        (row) =>
          row.playedAt >= publication.publishedAt && row.playedAt < windowEnd,
      );
      const publicationIdentities = new Set(
        snapshotTracks.map((track) => track.identityKey),
      );
      const sessionUsed = scrobblesInWindow.some((row) =>
        publicationIdentities.has(row.identityKey),
      );

      for (const track of newlyPresented) {
        const eventKey = `${publication.runId}\u0000${publication.targetPlaylistId}\u0000${track.trackKey}`;
        if (eventKeys.has(eventKey)) continue;
        eventKeys.add(eventKey);

        const consumption = scrobblesInWindow.find(
          (row) => row.identityKey === track.identityKey,
        );
        const usageEvidence: MusicExposureUsageEvidence = consumption
          ? "TRACK_CONSUMED"
          : sessionUsed
            ? "SESSION_USED_NO_TRACK_MATCH"
            : "SESSION_USAGE_UNCONFIRMED";
        const validExposure = sessionUsed;

        if (validExposure) targetSummary.validExposureCount += 1;
        if (consumption) targetSummary.confirmedConsumptionCount += 1;
        if (!sessionUsed) targetSummary.sessionUsageUnconfirmedCount += 1;

        events.push({
          eventKey,
          runId: publication.runId,
          targetPlaylistId: publication.targetPlaylistId,
          targetName: publication.targetName,
          trackKey: track.trackKey,
          trackName: track.trackName,
          artistName: track.artistName,
          position: track.position,
          exposedAt: publication.publishedAt,
          observationEndsAt: windowEnd,
          usageEvidence,
          validExposure,
          confirmedConsumptionAt: consumption?.playedAt ?? null,
        });
      }
    }
  }

  events.sort(compareEvent);
  const projections = buildProjection(events, threshold);

  return {
    threshold,
    publicationCount: publications.length,
    exposureCount: events.length,
    validExposureCount: events.filter((event) => event.validExposure).length,
    confirmedConsumptionCount: events.filter(
      (event) => event.confirmedConsumptionAt !== null,
    ).length,
    thresholdTrackCount: projections.filter((row) => row.wouldEnterCooldown).length,
    uniqueExposedTrackCount: projections.length,
    keepFilledBaselineSkippedCount: [...targetSummaries.values()].reduce(
      (sum, row) => sum + row.keepFilledBaselineSkippedCount,
      0,
    ),
    sessionUsageUnconfirmedCount: events.filter(
      (event) => event.usageEvidence === "SESSION_USAGE_UNCONFIRMED",
    ).length,
    events,
    projections,
    targets: [...targetSummaries.values()]
      .sort((left, right) => left.targetName.localeCompare(right.targetName))
      .map((row) => ({ ...row })),
  };
}

type NormalizedTrack = MusicExposureShadowTrack & { identityKey: string };
type NormalizedPublication = Omit<MusicExposureShadowPublication, "tracks"> & {
  tracks: NormalizedTrack[];
};
type NormalizedScrobble = MusicExposureShadowScrobble & { identityKey: string };
type MutableTargetSummary = {
  targetPlaylistId: string;
  targetName: string;
  publicationCount: number;
  validExposureCount: number;
  confirmedConsumptionCount: number;
  sessionUsageUnconfirmedCount: number;
  keepFilledBaselineSkippedCount: number;
};

function buildProjection(
  events: readonly MusicExposureShadowEvent[],
  threshold: number,
): MusicExposureShadowProjection[] {
  const byTrack = groupBy(events, (event) => event.trackKey);
  const rows: MusicExposureShadowProjection[] = [];

  for (const trackEvents of byTrack.values()) {
    trackEvents.sort(compareEvent);
    let validExposureCount = 0;
    let consecutiveUnconfirmedExposureCount = 0;
    let lastExposureAt: Date | null = null;
    let lastConfirmedConsumptionAt: Date | null = null;
    let thresholdReachedAt: Date | null = null;

    for (const event of trackEvents) {
      lastExposureAt = event.exposedAt;
      if (event.validExposure) validExposureCount += 1;
      if (event.confirmedConsumptionAt) {
        lastConfirmedConsumptionAt = event.confirmedConsumptionAt;
        consecutiveUnconfirmedExposureCount = 0;
        continue;
      }
      if (!event.validExposure) continue;

      consecutiveUnconfirmedExposureCount += 1;
      if (
        thresholdReachedAt === null &&
        consecutiveUnconfirmedExposureCount >= threshold
      ) {
        thresholdReachedAt = event.exposedAt;
      }
    }

    const exemplar = trackEvents[trackEvents.length - 1]!;
    rows.push({
      trackKey: exemplar.trackKey,
      trackName: exemplar.trackName,
      artistName: exemplar.artistName,
      validExposureCount,
      consecutiveUnconfirmedExposureCount,
      lastExposureAt,
      lastConfirmedConsumptionAt,
      thresholdReachedAt,
      wouldEnterCooldown: consecutiveUnconfirmedExposureCount >= threshold,
    });
  }

  return rows.sort((left, right) => {
    if (left.wouldEnterCooldown !== right.wouldEnterCooldown) {
      return left.wouldEnterCooldown ? -1 : 1;
    }
    if (
      left.consecutiveUnconfirmedExposureCount !==
      right.consecutiveUnconfirmedExposureCount
    ) {
      return (
        right.consecutiveUnconfirmedExposureCount -
        left.consecutiveUnconfirmedExposureCount
      );
    }
    return left.trackKey.localeCompare(right.trackKey);
  });
}

function isMeasurablePublication(
  publication: MusicExposureShadowPublication,
): boolean {
  return (
    !publication.simulation &&
    (publication.status === "SUCCESS" || publication.status === "PARTIAL") &&
    publication.tracks.length > 0 &&
    (publication.applied || publication.updatePolicy === "KEEP_FILLED")
  );
}

function normalizePublication(
  publication: MusicExposureShadowPublication,
): NormalizedPublication {
  assertDate(publication.publishedAt, "publishedAt");
  return {
    ...publication,
    runId: required(publication.runId, "runId"),
    targetPlaylistId: required(publication.targetPlaylistId, "targetPlaylistId"),
    targetName: required(publication.targetName, "targetName"),
    tracks: publication.tracks.flatMap((track) => {
      const trackKey = track.trackKey.trim();
      const trackName = track.trackName.trim();
      const artistName = track.artistName.trim();
      const identityKey = musicIdentityKey(trackName, artistName);
      if (!trackKey || !identityKey) return [];
      return [
        {
          ...track,
          trackKey,
          trackName,
          artistName,
          identityKey,
        },
      ];
    }),
  };
}

function normalizeScrobble(
  scrobble: MusicExposureShadowScrobble,
): NormalizedScrobble | null {
  assertDate(scrobble.playedAt, "scrobble.playedAt");
  const trackName = scrobble.trackName.trim();
  const artistName = scrobble.artistName.trim();
  const identityKey = musicIdentityKey(trackName, artistName);
  if (!identityKey) return null;
  return { ...scrobble, trackName, artistName, identityKey };
}

function musicIdentityKey(trackName: string, artistName: string): string {
  const track = normalizeMusicIdentityText(trackName);
  const artist = normalizeMusicIdentityText(artistName);
  return track && artist ? `${artist}\u0000${track}` : "";
}

function dedupePublications(
  publications: readonly NormalizedPublication[],
): NormalizedPublication[] {
  const byKey = new Map<string, NormalizedPublication>();
  for (const publication of publications) {
    const key = `${publication.runId}\u0000${publication.targetPlaylistId}`;
    if (!byKey.has(key)) byKey.set(key, publication);
  }
  return [...byKey.values()];
}

function dedupeTracks(tracks: readonly NormalizedTrack[]): NormalizedTrack[] {
  const byTrackKey = new Map<string, NormalizedTrack>();
  for (const track of tracks) {
    if (!byTrackKey.has(track.trackKey)) byTrackKey.set(track.trackKey, track);
  }
  return [...byTrackKey.values()].sort((left, right) => left.position - right.position);
}

function targetSummaryFor(
  summaries: Map<string, MutableTargetSummary>,
  publication: NormalizedPublication,
): MutableTargetSummary {
  const existing = summaries.get(publication.targetPlaylistId);
  if (existing) return existing;
  const created: MutableTargetSummary = {
    targetPlaylistId: publication.targetPlaylistId,
    targetName: publication.targetName,
    publicationCount: 0,
    validExposureCount: 0,
    confirmedConsumptionCount: 0,
    sessionUsageUnconfirmedCount: 0,
    keepFilledBaselineSkippedCount: 0,
  };
  summaries.set(publication.targetPlaylistId, created);
  return created;
}

function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const rowKey = key(row);
    const existing = grouped.get(rowKey);
    if (existing) existing.push(row);
    else grouped.set(rowKey, [row]);
  }
  return grouped;
}

function comparePublication(
  left: MusicExposureShadowPublication,
  right: MusicExposureShadowPublication,
): number {
  return (
    left.publishedAt.getTime() - right.publishedAt.getTime() ||
    left.targetPlaylistId.localeCompare(right.targetPlaylistId) ||
    left.runId.localeCompare(right.runId)
  );
}

function compareEvent(
  left: MusicExposureShadowEvent,
  right: MusicExposureShadowEvent,
): number {
  return (
    left.exposedAt.getTime() - right.exposedAt.getTime() ||
    left.targetPlaylistId.localeCompare(right.targetPlaylistId) ||
    left.position - right.position ||
    left.eventKey.localeCompare(right.eventKey)
  );
}

function minDate(...dates: Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`MUSIC-07 shadow requires ${label}`);
  return normalized;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MUSIC-07 shadow ${label} must be a positive integer`);
  }
  return value;
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-07 shadow requires valid ${label}`);
  }
}
