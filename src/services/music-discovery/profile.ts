import type {
  ListeningEventSource,
  MusicRepeatWindowUnit,
  PrismaClient,
} from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { computeMusicRepeatCutoff } from "@/services/spotify/recently-played";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TOP_N = 10;
const DEFAULT_DORMANT_DAYS = 365;
const DEFAULT_REDISCOVERY_GAP_DAYS = 180;

export type DiscoveryHistoryEvent = {
  source: ListeningEventSource;
  spotifyTrackId: string | null;
  spotifyUri: string | null;
  trackName: string;
  artistName: string;
  albumName: string | null;
  playedAt: Date;
  metadata: unknown;
};

export type DiscoveryPreferenceSignal = {
  spotifyTrackId: string;
  inferredAt: Date;
  consumedAt: Date | null;
};

export type DiscoveryTrackState = {
  spotifyTrackId: string;
  lastPlayedAt: Date;
};

export type DiscoveryPlaybackPolicy = {
  enabled: boolean;
  windowValue: number | null;
  windowUnit: MusicRepeatWindowUnit | null;
};

export type DiscoveryArtistProfile = {
  artistName: string;
  playCount: number;
  plays30d: number;
  previous30d: number;
  plays90d: number;
  plays365d: number;
  distinctTrackCount: number;
  distinctListeningDays: number;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  explicitSkipCount: number;
  inferredSkipCount: number;
  pendingInferredSkipCount: number;
  momentumDelta30d: number;
  momentumRatio30d: number | null;
  daysSinceLastPlay: number;
  rediscoveryGapDays: number | null;
};

export type DiscoveryTrackProfile = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string;
  artistName: string;
  albumName: string | null;
  playCount: number;
  plays30d: number;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  distinctListeningDays: number;
  extendedEvidenceCount: number;
  msPlayedEvidenceCount: number;
  explicitSkipCount: number;
  inferredSkipCount: number;
  pendingInferredSkipCount: number;
  cooldownLastPlayedAt: Date | null;
  cooldownEligible: boolean | null;
};

export type MusicDiscoveryProfile = {
  generatedAt: Date;
  heuristics: {
    dormantDays: number;
    rediscoveryGapDays: number;
    note: string;
  };
  coverage: {
    firstPlayedAt: Date | null;
    lastPlayedAt: Date | null;
    lastFmValidFrom: Date | null;
    totalCanonicalEvents: number;
    invalidLegacyLastFmExcluded: number;
    futureEventsExcluded: number;
    sourceCounts: Array<{ source: ListeningEventSource; count: number }>;
    canonicalSpotifyIdentityEvents: number;
    unresolvedIdentityEvents: number;
    extendedEvidenceEvents: number;
    msPlayedEvidenceEvents: number;
    explicitSkipEvents: number;
    inferredSkipSignals: number;
    pendingInferredSkipSignals: number;
    unmappedInferredSkipSignals: number;
  };
  cooldown: {
    enabled: boolean;
    complete: boolean;
    windowValue: number | null;
    windowUnit: MusicRepeatWindowUnit | null;
    cutoff: Date | null;
    trackedStateCount: number;
    blockedTrackCount: number;
  };
  topArtistsHistorical: DiscoveryArtistProfile[];
  topArtists30d: DiscoveryArtistProfile[];
  topArtists90d: DiscoveryArtistProfile[];
  topArtists365d: DiscoveryArtistProfile[];
  recentMomentum: DiscoveryArtistProfile[];
  dormantFavorites: DiscoveryArtistProfile[];
  rediscoveryReturns: DiscoveryArtistProfile[];
  topTracksHistorical: DiscoveryTrackProfile[];
  familiarCandidates: DiscoveryTrackProfile[];
  rediscoveryCandidates: DiscoveryTrackProfile[];
};

export type BuildMusicDiscoveryProfileInput = {
  asOf: Date;
  events: DiscoveryHistoryEvent[];
  inferredSkips: DiscoveryPreferenceSignal[];
  trackStates: DiscoveryTrackState[];
  playbackPolicy: DiscoveryPlaybackPolicy | null;
  lastFmValidFrom: Date | null;
  topN?: number;
  dormantDays?: number;
  rediscoveryGapDays?: number;
};

export type MusicDiscoveryProfileOptions = {
  asOf?: Date;
  topN?: number;
  dormantDays?: number;
  rediscoveryGapDays?: number;
  client?: PrismaClient;
};

type ExtendedEvidence = {
  present: boolean;
  msPlayed: number | null;
  explicitSkip: boolean;
};

type ArtistAggregate = {
  artistName: string;
  playCount: number;
  plays30d: number;
  previous30d: number;
  plays90d: number;
  plays365d: number;
  distinctTracks: Set<string>;
  distinctDays: Set<string>;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  explicitSkipCount: number;
  inferredSkipCount: number;
  pendingInferredSkipCount: number;
  firstRecentAt: Date | null;
  lastBeforeRecentWindow: Date | null;
};

type TrackAggregate = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string;
  artistName: string;
  artistKey: string;
  albumName: string | null;
  playCount: number;
  plays30d: number;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  latestLabelAt: Date;
  distinctDays: Set<string>;
  extendedEvidenceCount: number;
  msPlayedEvidenceCount: number;
  explicitSkipCount: number;
  inferredSkipCount: number;
  pendingInferredSkipCount: number;
};

export async function getMusicDiscoveryProfile(
  userId: string,
  options: MusicDiscoveryProfileOptions = {},
): Promise<MusicDiscoveryProfile> {
  const client = options.client ?? defaultPrisma;
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) throw new Error("Sonoriza user not found for DISCOVERY-01 profile");

  const [events, inferredSkips, trackStates, playbackPolicy, lastFmCoverage] =
    await Promise.all([
      client.trackListeningEvent.findMany({
        where: { userId },
        select: {
          source: true,
          spotifyTrackId: true,
          spotifyUri: true,
          trackName: true,
          artistName: true,
          albumName: true,
          playedAt: true,
          metadata: true,
        },
      }),
      client.musicPreferenceSignal.findMany({
        where: { userId, type: "INFERRED_SKIP" },
        select: {
          spotifyTrackId: true,
          inferredAt: true,
          consumedAt: true,
        },
      }),
      client.trackListeningState.findMany({
        where: { userId },
        select: { spotifyTrackId: true, lastPlayedAt: true },
      }),
      client.musicPlaybackPolicy.findUnique({
        where: { userId },
        select: { enabled: true, windowValue: true, windowUnit: true },
      }),
      client.lastFmBackfillRun.findFirst({
        where: { userId, acceptedEvents: { gt: 0 } },
        orderBy: { startedAt: "desc" },
        select: { from: true },
      }),
    ]);

  return buildMusicDiscoveryProfile({
    asOf: options.asOf ?? new Date(),
    events,
    inferredSkips,
    trackStates,
    playbackPolicy,
    lastFmValidFrom: lastFmCoverage?.from ?? null,
    topN: options.topN,
    dormantDays: options.dormantDays,
    rediscoveryGapDays: options.rediscoveryGapDays,
  });
}

export function buildMusicDiscoveryProfile(
  input: BuildMusicDiscoveryProfileInput,
): MusicDiscoveryProfile {
  const asOf = validDate(input.asOf, "asOf");
  const topN = positiveInteger(input.topN ?? DEFAULT_TOP_N, "topN", 100);
  const dormantDays = positiveInteger(
    input.dormantDays ?? DEFAULT_DORMANT_DAYS,
    "dormantDays",
    10_000,
  );
  const rediscoveryGapDays = positiveInteger(
    input.rediscoveryGapDays ?? DEFAULT_REDISCOVERY_GAP_DAYS,
    "rediscoveryGapDays",
    10_000,
  );

  const cutoff30 = daysBefore(asOf, 30);
  const cutoff60 = daysBefore(asOf, 60);
  const cutoff90 = daysBefore(asOf, 90);
  const cutoff365 = daysBefore(asOf, 365);
  const dormantCutoff = daysBefore(asOf, dormantDays);

  let invalidLegacyLastFmExcluded = 0;
  let futureEventsExcluded = 0;
  const events = input.events.filter((event) => {
    if (event.playedAt > asOf) {
      futureEventsExcluded += 1;
      return false;
    }
    if (
      event.source === "LASTFM_SCROBBLE" &&
      input.lastFmValidFrom &&
      event.playedAt < input.lastFmValidFrom
    ) {
      invalidLegacyLastFmExcluded += 1;
      return false;
    }
    return true;
  });

  const sourceCounts = new Map<ListeningEventSource, number>();
  const artists = new Map<string, ArtistAggregate>();
  const tracks = new Map<string, TrackAggregate>();
  let firstPlayedAt: Date | null = null;
  let lastPlayedAt: Date | null = null;
  let canonicalSpotifyIdentityEvents = 0;
  let unresolvedIdentityEvents = 0;
  let extendedEvidenceEvents = 0;
  let msPlayedEvidenceEvents = 0;
  let explicitSkipEvents = 0;

  for (const event of events) {
    sourceCounts.set(event.source, (sourceCounts.get(event.source) ?? 0) + 1);
    if (!firstPlayedAt || event.playedAt < firstPlayedAt) firstPlayedAt = event.playedAt;
    if (!lastPlayedAt || event.playedAt > lastPlayedAt) lastPlayedAt = event.playedAt;

    if (event.spotifyTrackId) canonicalSpotifyIdentityEvents += 1;
    else unresolvedIdentityEvents += 1;

    const evidence = extendedEvidence(event.metadata);
    if (evidence.present) extendedEvidenceEvents += 1;
    if (evidence.msPlayed !== null) msPlayedEvidenceEvents += 1;
    if (evidence.explicitSkip) explicitSkipEvents += 1;

    const artistKey = normalized(event.artistName);
    const trackKey = event.spotifyTrackId
      ? `spotify:${event.spotifyTrackId}`
      : `unresolved:${normalized(event.trackName)}:${normalized(event.albumName ?? "")}`;
    const dayKey = event.playedAt.toISOString().slice(0, 10);

    let artist = artists.get(artistKey);
    if (!artist) {
      artist = {
        artistName: event.artistName.trim(),
        playCount: 0,
        plays30d: 0,
        previous30d: 0,
        plays90d: 0,
        plays365d: 0,
        distinctTracks: new Set(),
        distinctDays: new Set(),
        firstPlayedAt: event.playedAt,
        lastPlayedAt: event.playedAt,
        explicitSkipCount: 0,
        inferredSkipCount: 0,
        pendingInferredSkipCount: 0,
        firstRecentAt: null,
        lastBeforeRecentWindow: null,
      };
      artists.set(artistKey, artist);
    }

    artist.playCount += 1;
    artist.distinctTracks.add(trackKey);
    artist.distinctDays.add(dayKey);
    if (event.playedAt < artist.firstPlayedAt) artist.firstPlayedAt = event.playedAt;
    if (event.playedAt > artist.lastPlayedAt) {
      artist.lastPlayedAt = event.playedAt;
      artist.artistName = event.artistName.trim();
    }
    if (event.playedAt >= cutoff30) {
      artist.plays30d += 1;
      if (!artist.firstRecentAt || event.playedAt < artist.firstRecentAt) {
        artist.firstRecentAt = event.playedAt;
      }
    } else if (event.playedAt >= cutoff60) {
      artist.previous30d += 1;
    }
    if (event.playedAt >= cutoff90) artist.plays90d += 1;
    if (event.playedAt >= cutoff365) artist.plays365d += 1;
    if (
      event.playedAt < cutoff30 &&
      (!artist.lastBeforeRecentWindow || event.playedAt > artist.lastBeforeRecentWindow)
    ) {
      artist.lastBeforeRecentWindow = event.playedAt;
    }
    if (evidence.explicitSkip) artist.explicitSkipCount += 1;

    if (!event.spotifyTrackId) continue;
    let track = tracks.get(event.spotifyTrackId);
    if (!track) {
      track = {
        spotifyTrackId: event.spotifyTrackId,
        spotifyUri: event.spotifyUri,
        trackName: event.trackName.trim(),
        artistName: event.artistName.trim(),
        artistKey,
        albumName: event.albumName?.trim() || null,
        playCount: 0,
        plays30d: 0,
        firstPlayedAt: event.playedAt,
        lastPlayedAt: event.playedAt,
        latestLabelAt: event.playedAt,
        distinctDays: new Set(),
        extendedEvidenceCount: 0,
        msPlayedEvidenceCount: 0,
        explicitSkipCount: 0,
        inferredSkipCount: 0,
        pendingInferredSkipCount: 0,
      };
      tracks.set(event.spotifyTrackId, track);
    }
    track.playCount += 1;
    track.distinctDays.add(dayKey);
    if (event.playedAt >= cutoff30) track.plays30d += 1;
    if (event.playedAt < track.firstPlayedAt) track.firstPlayedAt = event.playedAt;
    if (event.playedAt > track.lastPlayedAt) track.lastPlayedAt = event.playedAt;
    if (event.playedAt >= track.latestLabelAt) {
      track.latestLabelAt = event.playedAt;
      track.spotifyUri = event.spotifyUri ?? track.spotifyUri;
      track.trackName = event.trackName.trim();
      track.artistName = event.artistName.trim();
      track.artistKey = artistKey;
      track.albumName = event.albumName?.trim() || null;
    }
    if (evidence.present) track.extendedEvidenceCount += 1;
    if (evidence.msPlayed !== null) track.msPlayedEvidenceCount += 1;
    if (evidence.explicitSkip) track.explicitSkipCount += 1;
  }

  const asOfSignals = input.inferredSkips.filter((signal) => signal.inferredAt <= asOf);
  let pendingInferredSkipSignals = 0;
  let unmappedInferredSkipSignals = 0;
  for (const signal of asOfSignals) {
    const pending = signal.consumedAt === null || signal.consumedAt > asOf;
    if (pending) pendingInferredSkipSignals += 1;
    const track = tracks.get(signal.spotifyTrackId);
    if (!track) {
      unmappedInferredSkipSignals += 1;
      continue;
    }
    track.inferredSkipCount += 1;
    if (pending) track.pendingInferredSkipCount += 1;
    const artist = artists.get(track.artistKey);
    if (artist) {
      artist.inferredSkipCount += 1;
      if (pending) artist.pendingInferredSkipCount += 1;
    }
  }

  const policy = input.playbackPolicy;
  let cooldownCutoff: Date | null = null;
  const cooldownComplete = Boolean(
    !policy?.enabled || (policy.windowValue && policy.windowUnit),
  );
  if (policy?.enabled && policy.windowValue && policy.windowUnit) {
    cooldownCutoff = computeMusicRepeatCutoff(
      asOf,
      policy.windowValue,
      policy.windowUnit,
    );
  }
  const stateByTrackId = new Map(
    input.trackStates.map((state) => [state.spotifyTrackId, state.lastPlayedAt] as const),
  );
  const blockedTrackCount = cooldownCutoff
    ? input.trackStates.filter((state) => state.lastPlayedAt >= cooldownCutoff!).length
    : 0;

  const artistProfiles = [...artists.values()].map((artist) => {
    const rediscoveryGap =
      artist.firstRecentAt && artist.lastBeforeRecentWindow
        ? wholeDaysBetween(artist.lastBeforeRecentWindow, artist.firstRecentAt)
        : null;
    return {
      artistName: artist.artistName,
      playCount: artist.playCount,
      plays30d: artist.plays30d,
      previous30d: artist.previous30d,
      plays90d: artist.plays90d,
      plays365d: artist.plays365d,
      distinctTrackCount: artist.distinctTracks.size,
      distinctListeningDays: artist.distinctDays.size,
      firstPlayedAt: artist.firstPlayedAt,
      lastPlayedAt: artist.lastPlayedAt,
      explicitSkipCount: artist.explicitSkipCount,
      inferredSkipCount: artist.inferredSkipCount,
      pendingInferredSkipCount: artist.pendingInferredSkipCount,
      momentumDelta30d: artist.plays30d - artist.previous30d,
      momentumRatio30d:
        artist.previous30d > 0 ? artist.plays30d / artist.previous30d : null,
      daysSinceLastPlay: wholeDaysBetween(artist.lastPlayedAt, asOf),
      rediscoveryGapDays: rediscoveryGap,
    } satisfies DiscoveryArtistProfile;
  });

  const trackProfiles = [...tracks.values()].map((track) => {
    const cooldownLastPlayedAt = stateByTrackId.get(track.spotifyTrackId) ?? null;
    let cooldownEligible: boolean | null = true;
    if (policy?.enabled) {
      if (!cooldownComplete || !cooldownCutoff) cooldownEligible = null;
      else cooldownEligible = !cooldownLastPlayedAt || cooldownLastPlayedAt < cooldownCutoff;
    }
    return {
      spotifyTrackId: track.spotifyTrackId,
      spotifyUri: track.spotifyUri,
      trackName: track.trackName,
      artistName: track.artistName,
      albumName: track.albumName,
      playCount: track.playCount,
      plays30d: track.plays30d,
      firstPlayedAt: track.firstPlayedAt,
      lastPlayedAt: track.lastPlayedAt,
      distinctListeningDays: track.distinctDays.size,
      extendedEvidenceCount: track.extendedEvidenceCount,
      msPlayedEvidenceCount: track.msPlayedEvidenceCount,
      explicitSkipCount: track.explicitSkipCount,
      inferredSkipCount: track.inferredSkipCount,
      pendingInferredSkipCount: track.pendingInferredSkipCount,
      cooldownLastPlayedAt,
      cooldownEligible,
    } satisfies DiscoveryTrackProfile;
  });

  const byHistorical = (a: DiscoveryArtistProfile, b: DiscoveryArtistProfile) =>
    b.playCount - a.playCount || b.distinctListeningDays - a.distinctListeningDays ||
    a.artistName.localeCompare(b.artistName);
  const byWindow = (field: "plays30d" | "plays90d" | "plays365d") =>
    (a: DiscoveryArtistProfile, b: DiscoveryArtistProfile) =>
      b[field] - a[field] || byHistorical(a, b);

  const topArtistsHistorical = top(artistProfiles, topN, byHistorical);
  const topArtists30d = top(
    artistProfiles.filter((artist) => artist.plays30d > 0),
    topN,
    byWindow("plays30d"),
  );
  const topArtists90d = top(
    artistProfiles.filter((artist) => artist.plays90d > 0),
    topN,
    byWindow("plays90d"),
  );
  const topArtists365d = top(
    artistProfiles.filter((artist) => artist.plays365d > 0),
    topN,
    byWindow("plays365d"),
  );
  const recentMomentum = top(
    artistProfiles.filter(
      (artist) => artist.plays30d > 0 && artist.momentumDelta30d > 0,
    ),
    topN,
    (a, b) =>
      b.momentumDelta30d - a.momentumDelta30d ||
      b.plays30d - a.plays30d ||
      byHistorical(a, b),
  );
  const dormantFavorites = top(
    artistProfiles.filter((artist) => artist.lastPlayedAt < dormantCutoff),
    topN,
    byHistorical,
  );
  const rediscoveryReturns = top(
    artistProfiles.filter(
      (artist) =>
        artist.plays30d > 0 &&
        (artist.rediscoveryGapDays ?? 0) >= rediscoveryGapDays,
    ),
    topN,
    (a, b) =>
      (b.rediscoveryGapDays ?? 0) - (a.rediscoveryGapDays ?? 0) ||
      byHistorical(a, b),
  );

  const byTrackHistory = (a: DiscoveryTrackProfile, b: DiscoveryTrackProfile) =>
    b.playCount - a.playCount ||
    b.distinctListeningDays - a.distinctListeningDays ||
    `${a.artistName}\u0000${a.trackName}`.localeCompare(
      `${b.artistName}\u0000${b.trackName}`,
    );
  const topTracksHistorical = top(trackProfiles, topN, byTrackHistory);
  const familiarCandidates = top(
    trackProfiles.filter((track) => track.cooldownEligible === true),
    topN,
    byTrackHistory,
  );
  const rediscoveryCandidates = top(
    trackProfiles.filter(
      (track) => track.cooldownEligible === true && track.lastPlayedAt < dormantCutoff,
    ),
    topN,
    byTrackHistory,
  );

  return {
    generatedAt: asOf,
    heuristics: {
      dormantDays,
      rediscoveryGapDays,
      note:
        "Gate 1 exposes raw facts and transparent ranking heuristics only; final preference weights are intentionally not defined yet.",
    },
    coverage: {
      firstPlayedAt,
      lastPlayedAt,
      lastFmValidFrom: input.lastFmValidFrom,
      totalCanonicalEvents: events.length,
      invalidLegacyLastFmExcluded,
      futureEventsExcluded,
      sourceCounts: [...sourceCounts.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => a.source.localeCompare(b.source)),
      canonicalSpotifyIdentityEvents,
      unresolvedIdentityEvents,
      extendedEvidenceEvents,
      msPlayedEvidenceEvents,
      explicitSkipEvents,
      inferredSkipSignals: asOfSignals.length,
      pendingInferredSkipSignals,
      unmappedInferredSkipSignals,
    },
    cooldown: {
      enabled: policy?.enabled ?? false,
      complete: cooldownComplete,
      windowValue: policy?.windowValue ?? null,
      windowUnit: policy?.windowUnit ?? null,
      cutoff: cooldownCutoff,
      trackedStateCount: input.trackStates.length,
      blockedTrackCount,
    },
    topArtistsHistorical,
    topArtists30d,
    topArtists90d,
    topArtists365d,
    recentMomentum,
    dormantFavorites,
    rediscoveryReturns,
    topTracksHistorical,
    familiarCandidates,
    rediscoveryCandidates,
  };
}

function extendedEvidence(metadata: unknown): ExtendedEvidence {
  const root = record(metadata);
  const evidence = record(root?.spotifyExtendedHistory);
  if (!evidence) return { present: false, msPlayed: null, explicitSkip: false };
  const msPlayed =
    typeof evidence.msPlayed === "number" && Number.isFinite(evidence.msPlayed)
      ? evidence.msPlayed
      : null;
  return {
    present: true,
    msPlayed,
    explicitSkip: evidence.explicitSkip === true || evidence.skipped === true,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}

function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / DAY_MS));
}

function top<T>(items: T[], count: number, compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare).slice(0, count);
}

function positiveInteger(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${name} must be a valid Date`);
  }
  return new Date(value);
}
