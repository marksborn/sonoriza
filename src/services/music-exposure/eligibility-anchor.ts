import type { MusicRepeatWindowUnit } from "@prisma/client";

import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import type { Candidate } from "@/services/playlist-planner";

import type {
  MusicExposureShadowEvent,
  MusicExposureShadowReport,
  MusicExposureShadowScrobble,
} from "./shadow";

export const MUSIC_07_ELIGIBILITY_ANCHOR_SOURCE = "SONORIZA_EXPOSURE" as const;

export type MusicExposureEligibilityAnchor = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  consecutiveUnconfirmedExposureCount: number;
  threshold: number;
  anchorAt: Date;
  cooldownUntil: Date;
  source: typeof MUSIC_07_ELIGIBILITY_ANCHOR_SOURCE;
  active: boolean;
}>;

export type MusicExposureEligibilityProjection = Readonly<{
  status:
    | "READY"
    | "POLICY_DISABLED"
    | "POLICY_INCOMPLETE"
    | "LASTFM_INCOMPLETE";
  threshold: number;
  anchors: readonly MusicExposureEligibilityAnchor[];
  activeAnchors: readonly MusicExposureEligibilityAnchor[];
  activeTrackIds: ReadonlySet<string>;
}>;

export type MusicExposureEligibilityFilterResult = {
  candidates: Candidate[];
  exposureCooldownSkippedCount: number;
};

/**
 * Converts the Gate 2 exposure report into a first-party eligibility anchor.
 *
 * This deliberately does NOT touch TrackListeningState and never invents a
 * lastPlayedAt. The semantic anchor is `anchorAt` with source
 * SONORIZA_EXPOSURE. A factual Last.fm scrobble resets the unconfirmed exposure
 * streak, including a later scrobble that happened after the original session
 * observation window.
 */
export function buildMusicExposureEligibilityProjection(input: {
  report: MusicExposureShadowReport;
  scrobbles: readonly MusicExposureShadowScrobble[];
  lastFmComplete: boolean;
  policy: {
    enabled: boolean;
    windowValue: number | null;
    windowUnit: MusicRepeatWindowUnit | null;
  } | null;
  asOf: Date;
}): MusicExposureEligibilityProjection {
  assertDate(input.asOf, "asOf");

  if (!input.policy?.enabled) {
    return emptyProjection("POLICY_DISABLED", input.report.threshold);
  }
  if (
    !Number.isInteger(input.policy.windowValue) ||
    (input.policy.windowValue ?? 0) < 1 ||
    !input.policy.windowUnit
  ) {
    return emptyProjection("POLICY_INCOMPLETE", input.report.threshold);
  }
  if (!input.lastFmComplete && input.report.exposureCount > 0) {
    return emptyProjection("LASTFM_INCOMPLETE", input.report.threshold);
  }

  const scrobbles = input.scrobbles
    .map(normalizeScrobble)
    .filter((row): row is NormalizedScrobble => row !== null)
    .sort((left, right) => left.playedAt.getTime() - right.playedAt.getTime());
  const groups = groupBy(
    input.report.events.filter((event) => event.validExposure),
    (event) => `${event.targetPlaylistId}\u0000${event.trackKey}`,
  );
  const anchors: MusicExposureEligibilityAnchor[] = [];

  for (const events of groups.values()) {
    events.sort((left, right) => left.exposedAt.getTime() - right.exposedAt.getTime());
    const exemplar = events[events.length - 1]!;
    const spotifyTrackId = spotifyTrackIdFromKey(exemplar.trackKey);
    if (!spotifyTrackId) continue;

    const identityKey = musicIdentityKey(exemplar.trackName, exemplar.artistName);
    if (!identityKey) continue;
    const matchingScrobbles = scrobbles.filter((row) => row.identityKey === identityKey);

    let streak = 0;
    let cursorMs = Number.NEGATIVE_INFINITY;
    let lastUnconfirmedExposureAt: Date | null = null;

    for (const event of events) {
      const eventAtMs = event.exposedAt.getTime();
      const priorConsumption = matchingScrobbles.some((row) => {
        const playedAtMs = row.playedAt.getTime();
        return playedAtMs > cursorMs && playedAtMs <= eventAtMs;
      });
      if (priorConsumption) streak = 0;

      if (event.confirmedConsumptionAt) {
        streak = 0;
        cursorMs = Math.max(cursorMs, event.confirmedConsumptionAt.getTime());
        lastUnconfirmedExposureAt = null;
        continue;
      }

      streak += 1;
      lastUnconfirmedExposureAt = event.exposedAt;
      cursorMs = Math.max(cursorMs, eventAtMs);
    }

    if (lastUnconfirmedExposureAt) {
      const laterConsumption = matchingScrobbles.some(
        (row) =>
          row.playedAt > lastUnconfirmedExposureAt! && row.playedAt <= input.asOf,
      );
      if (laterConsumption) {
        streak = 0;
        lastUnconfirmedExposureAt = null;
      }
    }

    if (streak < input.report.threshold || !lastUnconfirmedExposureAt) continue;

    const cooldownUntil = addMusicRepeatWindow(
      lastUnconfirmedExposureAt,
      input.policy.windowValue!,
      input.policy.windowUnit,
    );
    anchors.push({
      targetPlaylistId: exemplar.targetPlaylistId,
      targetName: exemplar.targetName,
      spotifyTrackId,
      trackName: exemplar.trackName,
      artistName: exemplar.artistName,
      consecutiveUnconfirmedExposureCount: streak,
      threshold: input.report.threshold,
      anchorAt: lastUnconfirmedExposureAt,
      cooldownUntil,
      source: MUSIC_07_ELIGIBILITY_ANCHOR_SOURCE,
      active: cooldownUntil > input.asOf,
    });
  }

  anchors.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.anchorAt.getTime() - left.anchorAt.getTime();
  });
  const activeAnchors = anchors.filter((anchor) => anchor.active);

  return {
    status: "READY",
    threshold: input.report.threshold,
    anchors,
    activeAnchors,
    activeTrackIds: new Set(activeAnchors.map((anchor) => anchor.spotifyTrackId)),
  };
}

export function filterMusicCandidatesForExposureEligibility(
  candidates: Candidate[],
  blockedTrackIds: ReadonlySet<string>,
  enabled: boolean,
): MusicExposureEligibilityFilterResult {
  if (!enabled || blockedTrackIds.size === 0) {
    return { candidates, exposureCooldownSkippedCount: 0 };
  }

  const eligible: Candidate[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (
      candidate.type === "MUSIC" &&
      candidate.spotifyTrackId &&
      blockedTrackIds.has(candidate.spotifyTrackId)
    ) {
      skipped += 1;
      continue;
    }
    eligible.push(candidate);
  }
  return { candidates: eligible, exposureCooldownSkippedCount: skipped };
}

export function addMusicRepeatWindow(
  anchorAt: Date,
  windowValue: number,
  windowUnit: MusicRepeatWindowUnit,
): Date {
  assertDate(anchorAt, "anchorAt");
  if (!Number.isInteger(windowValue) || windowValue < 1) {
    throw new Error("MUSIC-07 cooldown window must be a positive integer");
  }
  const result = new Date(anchorAt);
  if (windowUnit === "DAYS") {
    result.setUTCDate(result.getUTCDate() + windowValue);
    return result;
  }

  const year = anchorAt.getUTCFullYear();
  const month = anchorAt.getUTCMonth();
  const day = anchorAt.getUTCDate();
  let targetYear = year;
  let targetMonth = month;
  if (windowUnit === "MONTHS") {
    const absoluteMonth = year * 12 + month + windowValue;
    targetYear = Math.floor(absoluteMonth / 12);
    targetMonth = ((absoluteMonth % 12) + 12) % 12;
  } else if (windowUnit === "YEARS") {
    targetYear = year + windowValue;
  } else {
    throw new Error(`Unsupported MUSIC-07 repeat window unit: ${windowUnit}`);
  }
  const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      anchorAt.getUTCHours(),
      anchorAt.getUTCMinutes(),
      anchorAt.getUTCSeconds(),
      anchorAt.getUTCMilliseconds(),
    ),
  );
}

type NormalizedScrobble = MusicExposureShadowScrobble & { identityKey: string };

function normalizeScrobble(
  scrobble: MusicExposureShadowScrobble,
): NormalizedScrobble | null {
  if (!Number.isFinite(scrobble.playedAt.getTime())) return null;
  const identityKey = musicIdentityKey(scrobble.trackName, scrobble.artistName);
  if (!identityKey) return null;
  return { ...scrobble, identityKey };
}

function musicIdentityKey(trackName: string, artistName: string): string {
  const track = normalizeMusicIdentityText(trackName);
  const artist = normalizeMusicIdentityText(artistName);
  return track && artist ? `${artist}\u0000${track}` : "";
}

function spotifyTrackIdFromKey(trackKey: string): string | null {
  const match = /^spotify:(.+)$/.exec(trackKey.trim());
  return match?.[1]?.trim() || null;
}

function emptyProjection(
  status: Exclude<MusicExposureEligibilityProjection["status"], "READY">,
  threshold: number,
): MusicExposureEligibilityProjection {
  return {
    status,
    threshold,
    anchors: [],
    activeAnchors: [],
    activeTrackIds: new Set<string>(),
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const bucketKey = key(row);
    const bucket = result.get(bucketKey);
    if (bucket) bucket.push(row);
    else result.set(bucketKey, [row]);
  }
  return result;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-07 requires valid ${label}`);
  }
}
