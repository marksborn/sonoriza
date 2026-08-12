import type { MusicRepeatWindowUnit } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/services/playlist-planner";

import { spotifyApiErrorFromResponse } from "./errors";
import {
  mapSpotifyRecentlyPlayedEvent,
  type SpotifyListeningEventInput,
} from "./listening-events";
import { canonicalSpotifyTrackId, type SpotifyMusicTrackLike } from "./music-availability";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;

export const RECENTLY_PLAYED_SCOPE = "user-read-recently-played";

export class MusicRepeatScopeRequiredError extends Error {
  constructor() {
    super("Reconnect Spotify to grant access to recently played tracks.");
    this.name = "MusicRepeatScopeRequiredError";
  }
}

export type MusicRepeatContext = {
  enabled: boolean;
  windowValue: number | null;
  windowUnit: MusicRepeatWindowUnit | null;
  cutoff: Date | null;
  historyKnownSince: Date | null;
  lastSyncAt: Date | null;
  blockedTrackIds: ReadonlySet<string>;
};

export type MusicRepeatFilterResult = {
  candidates: Candidate[];
  recentlyPlayedSkippedCount: number;
  missingTrackIdentitySkippedCount: number;
};

export type RecentlyPlayedSyncResult = {
  enabled: boolean;
  eventsRead: number;
  identitiesUpdated: number;
  listeningEventsInserted: number;
  listeningEventsDuplicateCount: number;
  historyKnownSince: Date | null;
  lastSyncAt: Date | null;
};

type RecentlyPlayedTrack = SpotifyMusicTrackLike & {
  id?: string | null;
  uri?: string | null;
  linked_from?: { id?: string | null } | null;
  external_ids?: { isrc?: string | null } | null;
};

type RecentlyPlayedContext = {
  type?: string | null;
  uri?: string | null;
};

type RecentlyPlayedPage = {
  items?: Array<{
    track?: RecentlyPlayedTrack | null;
    played_at?: string | null;
    context?: RecentlyPlayedContext | null;
  }>;
  next?: string | null;
  cursors?: { after?: string | null; before?: string | null } | null;
};

type PlaybackAggregate = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  lastPlayedAt: Date;
};

export function scopeIncludes(
  scope: string | null | undefined,
  expected: string,
): boolean {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean)).has(expected);
}

/**
 * Subtracts the user-selected calendar unit without silently converting months
 * or years to a fixed number of days. Month/year subtraction clamps dates such
 * as March 31 and February 29 to the last valid day of the target month.
 */
export function computeMusicRepeatCutoff(
  now: Date,
  windowValue: number,
  windowUnit: MusicRepeatWindowUnit,
): Date {
  if (!Number.isInteger(windowValue) || windowValue < 1) {
    throw new Error("Music repeat window must be a positive integer.");
  }

  if (windowUnit === "DAYS") {
    const result = new Date(now);
    result.setUTCDate(result.getUTCDate() - windowValue);
    return result;
  }

  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  let targetYear = year;
  let targetMonth = month;

  if (windowUnit === "MONTHS") {
    const absoluteMonth = year * 12 + month - windowValue;
    targetYear = Math.floor(absoluteMonth / 12);
    targetMonth = ((absoluteMonth % 12) + 12) % 12;
  } else if (windowUnit === "YEARS") {
    targetYear = year - windowValue;
  } else {
    throw new Error(`Unsupported music repeat window unit: ${windowUnit}`);
  }

  const clampedDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}

export function filterMusicCandidatesForRepeat(
  candidates: Candidate[],
  context: MusicRepeatContext,
): MusicRepeatFilterResult {
  if (!context.enabled) {
    return {
      candidates,
      recentlyPlayedSkippedCount: 0,
      missingTrackIdentitySkippedCount: 0,
    };
  }

  const eligible: Candidate[] = [];
  let recentlyPlayedSkippedCount = 0;
  let missingTrackIdentitySkippedCount = 0;

  for (const candidate of candidates) {
    if (candidate.type !== "MUSIC") {
      eligible.push(candidate);
      continue;
    }

    if (!candidate.spotifyTrackId) {
      // Safe default: an enabled cooldown must never be bypassed by missing
      // provider identity. This should only happen for malformed/legacy input.
      missingTrackIdentitySkippedCount += 1;
      continue;
    }

    if (context.blockedTrackIds.has(candidate.spotifyTrackId)) {
      recentlyPlayedSkippedCount += 1;
      continue;
    }

    eligible.push(candidate);
  }

  return {
    candidates: eligible,
    recentlyPlayedSkippedCount,
    missingTrackIdentitySkippedCount,
  };
}

/**
 * Synchronizes Spotify's Recently Played feed into both HISTORY-01's immutable
 * event stream and MUSIC-01's minimal `lastPlayedAt` projection. It never
 * writes to Spotify and is idempotent at both layers.
 */
export async function syncRecentlyPlayed(
  userId: string,
  now = new Date(),
): Promise<RecentlyPlayedSyncResult> {
  const policy = await prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
  });

  if (!policy?.enabled) {
    return {
      enabled: false,
      eventsRead: 0,
      identitiesUpdated: 0,
      listeningEventsInserted: 0,
      listeningEventsDuplicateCount: 0,
      historyKnownSince: policy?.historyKnownSince ?? null,
      lastSyncAt: policy?.lastSyncAt ?? null,
    };
  }

  assertValidPolicy(policy.windowValue, policy.windowUnit);

  const account = await prisma.account.findFirst({
    where: { userId, provider: "spotify" },
    select: { scope: true },
  });
  if (!account || !scopeIncludes(account.scope, RECENTLY_PLAYED_SCOPE)) {
    throw new MusicRepeatScopeRequiredError();
  }

  const accessToken = await getSpotifyAccessToken(userId);
  const syncStartedAt = now;
  let nextPath: string | null = policy.syncAfterCursor
    ? `/me/player/recently-played?limit=50&after=${encodeURIComponent(policy.syncAfterCursor)}`
    : "/me/player/recently-played?limit=50";
  let eventsRead = 0;
  let earliestSeen: Date | null = null;
  let latestSeenMs: number | null = null;
  const aggregates = new Map<string, PlaybackAggregate>();
  const listeningEvents = new Map<string, SpotifyListeningEventInput>();

  while (nextPath) {
    const page: RecentlyPlayedPage = await spotifyGet<RecentlyPlayedPage>(
      accessToken,
      nextPath,
    );
    for (const item of page.items ?? []) {
      const playedAt = parsePlayedAt(item.played_at);
      const track = item.track;
      if (!playedAt || !track) continue;

      const aliases = spotifyTrackIdentityAliases(track);
      if (aliases.length === 0) continue;

      eventsRead += 1;
      if (!earliestSeen || playedAt < earliestSeen) earliestSeen = playedAt;
      const playedAtMs = playedAt.getTime();
      latestSeenMs = latestSeenMs === null ? playedAtMs : Math.max(latestSeenMs, playedAtMs);
      const spotifyUri = typeof track.uri === "string" && track.uri ? track.uri : null;
      const event = mapSpotifyRecentlyPlayedEvent({
        track,
        playedAt,
        context: item.context,
      });
      if (event) listeningEvents.set(event.sourceEventKey, event);

      for (const spotifyTrackId of aliases) {
        const existing = aggregates.get(spotifyTrackId);
        if (!existing || playedAt > existing.lastPlayedAt) {
          aggregates.set(spotifyTrackId, {
            spotifyTrackId,
            spotifyUri,
            lastPlayedAt: playedAt,
          });
        }
      }
    }

    nextPath = page.next ? stripSpotifyBase(page.next) : null;
  }

  const identities = [...aggregates.keys()];
  const existingStates = identities.length
    ? await prisma.trackListeningState.findMany({
        where: { userId, spotifyTrackId: { in: identities } },
        select: { spotifyTrackId: true, lastPlayedAt: true, spotifyUri: true },
      })
    : [];
  const existingById = new Map(
    existingStates.map((state) => [state.spotifyTrackId, state]),
  );

  const operations = [...aggregates.values()].map((aggregate) => {
    const existing = existingById.get(aggregate.spotifyTrackId);
    const lastPlayedAt =
      existing && existing.lastPlayedAt > aggregate.lastPlayedAt
        ? existing.lastPlayedAt
        : aggregate.lastPlayedAt;
    const spotifyUri = aggregate.spotifyUri ?? existing?.spotifyUri ?? null;

    return prisma.trackListeningState.upsert({
      where: {
        userId_spotifyTrackId: {
          userId,
          spotifyTrackId: aggregate.spotifyTrackId,
        },
      },
      create: {
        userId,
        spotifyTrackId: aggregate.spotifyTrackId,
        spotifyUri,
        lastPlayedAt,
      },
      update: {
        spotifyUri,
        lastPlayedAt,
      },
    });
  });
  if (operations.length > 0) await prisma.$transaction(operations);

  const eventRows = [...listeningEvents.values()].map((event) => ({
    userId,
    spotifyTrackId: event.spotifyTrackId,
    spotifyUri: event.spotifyUri,
    trackName: event.trackName,
    artistName: event.artistName,
    primaryArtistId: event.primaryArtistId,
    albumName: event.albumName,
    albumId: event.albumId,
    isrc: event.isrc,
    playedAt: event.playedAt,
    source: "SPOTIFY_RECENTLY_PLAYED" as const,
    sourceEventKey: event.sourceEventKey,
    contextType: event.contextType,
    contextUri: event.contextUri,
  }));
  const eventWrite = eventRows.length
    ? await prisma.trackListeningEvent.createMany({
        data: eventRows,
        skipDuplicates: true,
      })
    : { count: 0 };
  const listeningEventsDuplicateCount = eventRows.length - eventWrite.count;

  const historyKnownSince = minDate(policy.historyKnownSince, earliestSeen);
  const priorCursorMs = parseCursorMs(policy.syncAfterCursor);
  const nextCursorMs =
    latestSeenMs ?? priorCursorMs ?? syncStartedAt.getTime();
  await prisma.musicPlaybackPolicy.update({
    where: { userId },
    data: {
      historyKnownSince,
      lastSyncAt: syncStartedAt,
      syncAfterCursor: String(nextCursorMs),
    },
  });

  return {
    enabled: true,
    eventsRead,
    identitiesUpdated: operations.length,
    listeningEventsInserted: eventWrite.count,
    listeningEventsDuplicateCount,
    historyKnownSince,
    lastSyncAt: syncStartedAt,
  };
}

export async function loadMusicRepeatContext(
  userId: string,
  now = new Date(),
): Promise<MusicRepeatContext> {
  const policy = await prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
  });

  if (!policy?.enabled) {
    return {
      enabled: false,
      windowValue: policy?.windowValue ?? null,
      windowUnit: policy?.windowUnit ?? null,
      cutoff: null,
      historyKnownSince: policy?.historyKnownSince ?? null,
      lastSyncAt: policy?.lastSyncAt ?? null,
      blockedTrackIds: new Set(),
    };
  }

  assertValidPolicy(policy.windowValue, policy.windowUnit);
  const cutoff = computeMusicRepeatCutoff(now, policy.windowValue!, policy.windowUnit!);
  const blocked = await prisma.trackListeningState.findMany({
    where: {
      userId,
      lastPlayedAt: { gte: cutoff },
    },
    select: { spotifyTrackId: true },
  });

  return {
    enabled: true,
    windowValue: policy.windowValue,
    windowUnit: policy.windowUnit,
    cutoff,
    historyKnownSince: policy.historyKnownSince,
    lastSyncAt: policy.lastSyncAt,
    blockedTrackIds: new Set(blocked.map((state) => state.spotifyTrackId)),
  };
}

export async function refreshMusicRepeatContext(
  userId: string,
  now = new Date(),
): Promise<{ sync: RecentlyPlayedSyncResult; context: MusicRepeatContext }> {
  const sync = await syncRecentlyPlayed(userId, now);
  const context = await loadMusicRepeatContext(userId, now);
  return { sync, context };
}

export function spotifyTrackIdentityAliases(
  track: Pick<SpotifyMusicTrackLike, "id" | "uri" | "linked_from">,
): string[] {
  const aliases = new Set<string>();
  const canonical = canonicalSpotifyTrackId(track);
  if (canonical) aliases.add(canonical);
  if (typeof track.id === "string" && track.id.trim()) aliases.add(track.id.trim());
  if (typeof track.uri === "string") {
    const match = /^spotify:track:([^:]+)$/.exec(track.uri.trim());
    if (match?.[1]) aliases.add(match[1]);
  }
  if (typeof track.linked_from?.id === "string" && track.linked_from.id.trim()) {
    aliases.add(track.linked_from.id.trim());
  }
  return [...aliases];
}

function assertValidPolicy(
  windowValue: number | null,
  windowUnit: MusicRepeatWindowUnit | null,
): asserts windowValue is number {
  if (!Number.isInteger(windowValue) || (windowValue ?? 0) < 1 || !windowUnit) {
    throw new Error("Enabled music repeat policy is incomplete.");
  }
}

async function spotifyGet<T>(accessToken: string, path: string): Promise<T> {
  let retries = 0;
  while (true) {
    const response = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) return (await response.json()) as T;

    const error = await spotifyApiErrorFromResponse(response, {
      method: "GET",
      operation: "recently-played",
    });
    if (error.kind === "RATE_LIMITED" && retries < MAX_RATE_LIMIT_RETRIES) {
      retries += 1;
      const waitMs =
        Math.max(
          0,
          error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS,
        ) * 1000 + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
      await sleep(waitMs);
      continue;
    }
    throw error;
  }
}

function parsePlayedAt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function parseCursorMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function stripSpotifyBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function minDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
