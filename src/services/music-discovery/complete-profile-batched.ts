import type { ListeningEventSource, PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";
import { computeMusicRepeatCutoff } from "@/services/spotify/recently-played";

import type {
  CooldownLastPlayedSource,
  DiscoveryArtistProfile,
  DiscoveryHistoryEvent,
  DiscoveryPlaybackPolicy,
  DiscoveryPreferenceSignal,
  DiscoveryTrackProfile,
  DiscoveryTrackState,
  MusicDiscoveryProfile,
  MusicDiscoveryProfileOptions,
} from "./profile";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_DORMANT_DAYS = 365;
const DEFAULT_REDISCOVERY_GAP_DAYS = 180;
const MIN_MOMENTUM_LISTENING_DAYS = 3;
const MIN_REDISCOVERY_PRIOR_PLAYS = 10;
const MIN_REDISCOVERY_RECENT_PLAYS = 2;
const SYNTHETIC_EPOCH_CUTOFF = new Date("1971-01-01T00:00:00.000Z");

export const COMPLETE_PROFILE_EVENT_BATCH_SIZE = 2_000;

const NON_MUSICAL_ARTIST_KEYS = new Set(["spotify"]);
const ARTIST_ALIAS_KEYS = new Map<string, string>([
  ["detonautas", "detonautas roque clube"],
]);
const CANONICAL_ARTIST_LABELS = new Map<string, string>([
  ["detonautas roque clube", "Detonautas Roque Clube"],
]);

type ExtendedEvidence = {
  present: boolean;
  msPlayed: number | null;
  explicitSkip: boolean;
};

type ArtistAggregate = {
  artistName: string;
  canonicalLabelLocked: boolean;
  playCount: number;
  plays30d: number;
  previous30d: number;
  plays90d: number;
  plays365d: number;
  distinctTracks: Set<TrackAggregate | string>;
  distinctDays: Set<number>;
  recentDays: Set<number>;
  previousRecentDays: Set<number>;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  extendedEvidenceCount: number;
  msPlayedEvidenceCount: number;
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
  canonicalArtistLabelLocked: boolean;
  albumName: string | null;
  playCount: number;
  plays30d: number;
  firstPlayedAt: Date;
  lastPlayedAt: Date;
  latestLabelAt: Date;
  distinctDays: Set<number>;
  extendedEvidenceCount: number;
  msPlayedEvidenceCount: number;
  explicitSkipCount: number;
  inferredSkipCount: number;
  pendingInferredSkipCount: number;
};

type ArtistIdentity = {
  key: string;
  displayName: string;
  canonicalized: boolean;
  canonicalLabelLocked: boolean;
};

type CompleteProfileAccumulator = {
  sourceCounts: Map<ListeningEventSource, number>;
  artists: Map<string, ArtistAggregate>;
  tracks: Map<string, TrackAggregate>;
  totalCanonicalEvents: number;
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
  invalidLegacyLastFmExcluded: number;
  invalidSyntheticEpochEventsExcluded: number;
  futureEventsExcluded: number;
  canonicalSpotifyIdentityEvents: number;
  unresolvedIdentityEvents: number;
  extendedEvidenceEvents: number;
  msPlayedEvidenceEvents: number;
  explicitSkipEvents: number;
  nonMusicalProfileEventsExcluded: number;
  artistAliasEventsCanonicalized: number;
};

type CompleteProfileEventRow = DiscoveryHistoryEvent & { id: string };

type CompleteProfileOptions = Omit<
  MusicDiscoveryProfileOptions,
  "topN" | "completeUniverse"
>;

type FinalizeProfileInput = {
  accumulator: CompleteProfileAccumulator;
  asOf: Date;
  dormantDays: number;
  rediscoveryGapDays: number;
  inferredSkips: DiscoveryPreferenceSignal[];
  trackStates: DiscoveryTrackState[];
  playbackPolicy: DiscoveryPlaybackPolicy | null;
  lastFmValidFrom: Date | null;
};

export type RetainedCompleteMusicDiscoveryProfile = Pick<
  MusicDiscoveryProfile,
  | "generatedAt"
  | "heuristics"
  | "coverage"
  | "cooldown"
  | "topArtistsHistorical"
  | "topTracksHistorical"
>;

type PreparedCompleteMusicDiscoveryProfile =
  RetainedCompleteMusicDiscoveryProfile & {
    artistProfiles: DiscoveryArtistProfile[];
    trackProfiles: DiscoveryTrackProfile[];
  };

/**
 * PERF-01 complete-universe loader.
 *
 * The legacy complete path materializes every TrackListeningEvent before the
 * canonical aggregator runs. With a six-figure history this creates a very
 * large Prisma/Node object graph. This loader keeps the same aggregate facts,
 * but only retains one bounded event page at a time; historical Maps/Sets are
 * the long-lived state.
 */
export async function getBatchedCompleteMusicDiscoveryProfile(
  userId: string,
  options: CompleteProfileOptions = {},
): Promise<MusicDiscoveryProfile> {
  return loadBatchedCompleteMusicDiscoveryProfile(userId, options, finalizeProfile);
}

/**
 * PERF-01 runtime finalizer.
 *
 * Runtime scoring only needs canonical historical artist/track universes plus
 * profile context. This path shares the exact same paged aggregation and
 * canonical profile projection, but intentionally stops before allocating the
 * redundant diagnostic/window/candidate views of the full profile.
 */
export async function getBatchedRetainedCompleteMusicDiscoveryProfile(
  userId: string,
  options: CompleteProfileOptions = {},
): Promise<RetainedCompleteMusicDiscoveryProfile> {
  return loadBatchedCompleteMusicDiscoveryProfile(
    userId,
    options,
    finalizeRetainedProfile,
  );
}

async function loadBatchedCompleteMusicDiscoveryProfile<T>(
  userId: string,
  options: CompleteProfileOptions,
  finalize: (input: FinalizeProfileInput) => T,
): Promise<T> {
  const client = options.client ?? defaultPrisma;
  const asOf = validDate(options.asOf ?? new Date(), "asOf");
  const dormantDays = positiveInteger(
    options.dormantDays ?? DEFAULT_DORMANT_DAYS,
    "dormantDays",
    10_000,
  );
  const rediscoveryGapDays = positiveInteger(
    options.rediscoveryGapDays ?? DEFAULT_REDISCOVERY_GAP_DAYS,
    "rediscoveryGapDays",
    10_000,
  );

  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) throw new Error("Sonoriza user not found for DISCOVERY-01 profile");

  const [inferredSkips, trackStates, playbackPolicy, lastFmCoverage] =
    await Promise.all([
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

  const accumulator = createAccumulator();
  const cutoffs = {
    cutoff30: daysBefore(asOf, 30),
    cutoff60: daysBefore(asOf, 60),
    cutoff90: daysBefore(asOf, 90),
    cutoff365: daysBefore(asOf, 365),
  };
  const lastFmValidFrom = lastFmCoverage?.from ?? null;

  let cursorId: string | null = null;
  for (;;) {
    const page = await loadEventPage(client, userId, cursorId);
    if (page.length === 0) break;

    for (const event of page) {
      aggregateEvent(accumulator, event, {
        asOf,
        lastFmValidFrom,
        ...cutoffs,
      });
    }

    cursorId = page[page.length - 1]!.id;
    if (page.length < COMPLETE_PROFILE_EVENT_BATCH_SIZE) break;
  }

  return finalize({
    accumulator,
    asOf,
    dormantDays,
    rediscoveryGapDays,
    inferredSkips,
    trackStates,
    playbackPolicy,
    lastFmValidFrom,
  });
}

async function loadEventPage(
  client: PrismaClient,
  userId: string,
  cursorId: string | null,
): Promise<CompleteProfileEventRow[]> {
  return client.trackListeningEvent.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    take: COMPLETE_PROFILE_EVENT_BATCH_SIZE,
    ...(cursorId
      ? {
          cursor: { id: cursorId },
          skip: 1,
        }
      : {}),
    select: {
      id: true,
      source: true,
      spotifyTrackId: true,
      spotifyUri: true,
      trackName: true,
      artistName: true,
      albumName: true,
      playedAt: true,
      metadata: true,
    },
  });
}

function createAccumulator(): CompleteProfileAccumulator {
  return {
    sourceCounts: new Map(),
    artists: new Map(),
    tracks: new Map(),
    totalCanonicalEvents: 0,
    firstPlayedAt: null,
    lastPlayedAt: null,
    invalidLegacyLastFmExcluded: 0,
    invalidSyntheticEpochEventsExcluded: 0,
    futureEventsExcluded: 0,
    canonicalSpotifyIdentityEvents: 0,
    unresolvedIdentityEvents: 0,
    extendedEvidenceEvents: 0,
    msPlayedEvidenceEvents: 0,
    explicitSkipEvents: 0,
    nonMusicalProfileEventsExcluded: 0,
    artistAliasEventsCanonicalized: 0,
  };
}

function aggregateEvent(
  state: CompleteProfileAccumulator,
  event: DiscoveryHistoryEvent,
  input: {
    asOf: Date;
    lastFmValidFrom: Date | null;
    cutoff30: Date;
    cutoff60: Date;
    cutoff90: Date;
    cutoff365: Date;
  },
): void {
  if (event.playedAt > input.asOf) {
    state.futureEventsExcluded += 1;
    return;
  }
  if (event.playedAt < SYNTHETIC_EPOCH_CUTOFF) {
    state.invalidSyntheticEpochEventsExcluded += 1;
    if (
      event.source === "LASTFM_SCROBBLE" &&
      input.lastFmValidFrom &&
      event.playedAt < input.lastFmValidFrom
    ) {
      state.invalidLegacyLastFmExcluded += 1;
    }
    return;
  }
  if (
    event.source === "LASTFM_SCROBBLE" &&
    input.lastFmValidFrom &&
    event.playedAt < input.lastFmValidFrom
  ) {
    state.invalidLegacyLastFmExcluded += 1;
    return;
  }

  state.totalCanonicalEvents += 1;
  state.sourceCounts.set(
    event.source,
    (state.sourceCounts.get(event.source) ?? 0) + 1,
  );
  if (!state.firstPlayedAt || event.playedAt < state.firstPlayedAt) {
    state.firstPlayedAt = event.playedAt;
  }
  if (!state.lastPlayedAt || event.playedAt > state.lastPlayedAt) {
    state.lastPlayedAt = event.playedAt;
  }

  if (event.spotifyTrackId) state.canonicalSpotifyIdentityEvents += 1;
  else state.unresolvedIdentityEvents += 1;

  const evidence = extendedEvidence(event.metadata);
  if (evidence.present) state.extendedEvidenceEvents += 1;
  if (evidence.msPlayed !== null) state.msPlayedEvidenceEvents += 1;
  if (evidence.explicitSkip) state.explicitSkipEvents += 1;

  if (isNonMusicalProfileEvent(event)) {
    state.nonMusicalProfileEventsExcluded += 1;
    return;
  }

  const identity = artistIdentity(event.artistName);
  if (identity.canonicalized) state.artistAliasEventsCanonicalized += 1;
  const artistKey = identity.key;
  const unresolvedTrackKey = event.spotifyTrackId
    ? null
    : `unresolved:${normalized(event.trackName)}:${normalized(event.albumName ?? "")}`;
  const dayKey = utcEpochDay(event.playedAt);

  let track: TrackAggregate | null = null;
  if (event.spotifyTrackId) {
    track = state.tracks.get(event.spotifyTrackId) ?? null;
    if (!track) {
      track = {
        spotifyTrackId: event.spotifyTrackId,
        spotifyUri: event.spotifyUri,
        trackName: event.trackName.trim(),
        artistName: identity.displayName,
        artistKey,
        canonicalArtistLabelLocked: identity.canonicalLabelLocked,
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
      state.tracks.set(event.spotifyTrackId, track);
    }
  }

  let artist = state.artists.get(artistKey);
  if (!artist) {
    artist = {
      artistName: identity.displayName,
      canonicalLabelLocked: identity.canonicalLabelLocked,
      playCount: 0,
      plays30d: 0,
      previous30d: 0,
      plays90d: 0,
      plays365d: 0,
      distinctTracks: new Set(),
      distinctDays: new Set(),
      recentDays: new Set(),
      previousRecentDays: new Set(),
      firstPlayedAt: event.playedAt,
      lastPlayedAt: event.playedAt,
      extendedEvidenceCount: 0,
      msPlayedEvidenceCount: 0,
      explicitSkipCount: 0,
      inferredSkipCount: 0,
      pendingInferredSkipCount: 0,
      firstRecentAt: null,
      lastBeforeRecentWindow: null,
    };
    state.artists.set(artistKey, artist);
  }

  artist.playCount += 1;
  artist.distinctTracks.add(track ?? unresolvedTrackKey!);
  artist.distinctDays.add(dayKey);
  if (event.playedAt < artist.firstPlayedAt) artist.firstPlayedAt = event.playedAt;
  if (event.playedAt > artist.lastPlayedAt) {
    artist.lastPlayedAt = event.playedAt;
    if (!artist.canonicalLabelLocked) artist.artistName = identity.displayName;
  }
  if (event.playedAt >= input.cutoff30) {
    artist.plays30d += 1;
    artist.recentDays.add(dayKey);
    if (!artist.firstRecentAt || event.playedAt < artist.firstRecentAt) {
      artist.firstRecentAt = event.playedAt;
    }
  } else if (event.playedAt >= input.cutoff60) {
    artist.previous30d += 1;
    artist.previousRecentDays.add(dayKey);
  }
  if (event.playedAt >= input.cutoff90) artist.plays90d += 1;
  if (event.playedAt >= input.cutoff365) artist.plays365d += 1;
  if (
    event.playedAt < input.cutoff30 &&
    (!artist.lastBeforeRecentWindow || event.playedAt > artist.lastBeforeRecentWindow)
  ) {
    artist.lastBeforeRecentWindow = event.playedAt;
  }
  if (evidence.present) artist.extendedEvidenceCount += 1;
  if (evidence.msPlayed !== null) artist.msPlayedEvidenceCount += 1;
  if (evidence.explicitSkip) artist.explicitSkipCount += 1;

  if (!track) return;

  track.playCount += 1;
  track.distinctDays.add(dayKey);
  if (event.playedAt >= input.cutoff30) track.plays30d += 1;
  if (event.playedAt < track.firstPlayedAt) track.firstPlayedAt = event.playedAt;
  if (event.playedAt > track.lastPlayedAt) track.lastPlayedAt = event.playedAt;
  if (event.playedAt >= track.latestLabelAt) {
    track.latestLabelAt = event.playedAt;
    track.spotifyUri = event.spotifyUri ?? track.spotifyUri;
    track.trackName = event.trackName.trim();
    track.artistKey = artistKey;
    track.canonicalArtistLabelLocked = identity.canonicalLabelLocked;
    if (!track.canonicalArtistLabelLocked) track.artistName = identity.displayName;
    else {
      track.artistName =
        CANONICAL_ARTIST_LABELS.get(artistKey) ?? identity.displayName;
    }
    track.albumName = event.albumName?.trim() || null;
  }
  if (evidence.present) track.extendedEvidenceCount += 1;
  if (evidence.msPlayed !== null) track.msPlayedEvidenceCount += 1;
  if (evidence.explicitSkip) track.explicitSkipCount += 1;
}

function prepareFinalizedProfile(
  input: FinalizeProfileInput,
): PreparedCompleteMusicDiscoveryProfile {
  const {
    accumulator: state,
    asOf,
    dormantDays,
    rediscoveryGapDays,
    inferredSkips,
    trackStates,
    playbackPolicy: policy,
    lastFmValidFrom,
  } = input;

  const asOfSignals = inferredSkips.filter((signal) => signal.inferredAt <= asOf);
  let pendingInferredSkipSignals = 0;
  let unmappedInferredSkipSignals = 0;
  for (const signal of asOfSignals) {
    const pending = signal.consumedAt === null || signal.consumedAt > asOf;
    if (pending) pendingInferredSkipSignals += 1;
    const track = state.tracks.get(signal.spotifyTrackId);
    if (!track) {
      unmappedInferredSkipSignals += 1;
      continue;
    }
    track.inferredSkipCount += 1;
    if (pending) track.pendingInferredSkipCount += 1;
    const artist = state.artists.get(track.artistKey);
    if (artist) {
      artist.inferredSkipCount += 1;
      if (pending) artist.pendingInferredSkipCount += 1;
    }
  }

  const cooldownComplete = Boolean(
    !policy?.enabled ||
      (policy.windowValue !== null &&
        policy.windowValue > 0 &&
        policy.windowUnit !== null),
  );
  let cooldownCutoff: Date | null = null;
  if (
    policy?.enabled &&
    cooldownComplete &&
    policy.windowValue !== null &&
    policy.windowUnit !== null
  ) {
    cooldownCutoff = computeMusicRepeatCutoff(
      asOf,
      policy.windowValue,
      policy.windowUnit,
    );
  }
  const stateByTrackId = new Map(
    trackStates.map(
      (trackState) => [trackState.spotifyTrackId, trackState.lastPlayedAt] as const,
    ),
  );

  const artistProfiles = [...state.artists.values()].map((artist) => {
    const rediscoveryGap =
      artist.firstRecentAt && artist.lastBeforeRecentWindow
        ? wholeDaysBetween(artist.lastBeforeRecentWindow, artist.firstRecentAt)
        : null;
    const priorPlayCount = Math.max(0, artist.playCount - artist.plays30d);
    return {
      artistName: artist.artistName,
      playCount: artist.playCount,
      priorPlayCount,
      plays30d: artist.plays30d,
      previous30d: artist.previous30d,
      plays90d: artist.plays90d,
      plays365d: artist.plays365d,
      distinctTrackCount: artist.distinctTracks.size,
      distinctListeningDays: artist.distinctDays.size,
      listeningDays30d: artist.recentDays.size,
      previousListeningDays30d: artist.previousRecentDays.size,
      firstPlayedAt: artist.firstPlayedAt,
      lastPlayedAt: artist.lastPlayedAt,
      extendedEvidenceCount: artist.extendedEvidenceCount,
      msPlayedEvidenceCount: artist.msPlayedEvidenceCount,
      explicitSkipCount: artist.explicitSkipCount,
      explicitSkipRate: ratioOrNull(
        artist.explicitSkipCount,
        artist.extendedEvidenceCount,
      ),
      inferredSkipCount: artist.inferredSkipCount,
      pendingInferredSkipCount: artist.pendingInferredSkipCount,
      momentumDelta30d: artist.plays30d - artist.previous30d,
      momentumListeningDayDelta30d:
        artist.recentDays.size - artist.previousRecentDays.size,
      momentumRatio30d:
        artist.previous30d > 0 ? artist.plays30d / artist.previous30d : null,
      daysSinceLastPlay: wholeDaysBetween(artist.lastPlayedAt, asOf),
      rediscoveryGapDays: rediscoveryGap,
    } satisfies DiscoveryArtistProfile;
  });

  let timelineFallbackTrackCount = 0;
  let timelineOverrideTrackCount = 0;
  const trackProfiles = [...state.tracks.values()].map((track) => {
    const stateLastPlayedAt = stateByTrackId.get(track.spotifyTrackId) ?? null;
    const timelineLastPlayedAt = track.lastPlayedAt;
    let cooldownLastPlayedAt: Date | null = null;
    let cooldownLastPlayedSource: CooldownLastPlayedSource | null = null;

    if (!stateLastPlayedAt) {
      cooldownLastPlayedAt = timelineLastPlayedAt;
      cooldownLastPlayedSource = "TIMELINE";
      timelineFallbackTrackCount += 1;
    } else if (stateLastPlayedAt.getTime() === timelineLastPlayedAt.getTime()) {
      cooldownLastPlayedAt = stateLastPlayedAt;
      cooldownLastPlayedSource = "STATE_AND_TIMELINE";
    } else if (timelineLastPlayedAt > stateLastPlayedAt) {
      cooldownLastPlayedAt = timelineLastPlayedAt;
      cooldownLastPlayedSource = "TIMELINE";
      timelineOverrideTrackCount += 1;
    } else {
      cooldownLastPlayedAt = stateLastPlayedAt;
      cooldownLastPlayedSource = "STATE";
    }

    let cooldownEligible: boolean | null = true;
    if (policy?.enabled) {
      if (!cooldownComplete || !cooldownCutoff) cooldownEligible = null;
      else cooldownEligible = cooldownLastPlayedAt < cooldownCutoff;
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
      explicitSkipRate: ratioOrNull(
        track.explicitSkipCount,
        track.extendedEvidenceCount,
      ),
      inferredSkipCount: track.inferredSkipCount,
      pendingInferredSkipCount: track.pendingInferredSkipCount,
      cooldownLastPlayedAt,
      cooldownLastPlayedSource,
      cooldownEligible,
    } satisfies DiscoveryTrackProfile;
  });

  const blockedTrackCount = trackProfiles.filter(
    (track) => track.cooldownEligible === false,
  ).length;

  const byHistorical = (a: DiscoveryArtistProfile, b: DiscoveryArtistProfile) =>
    b.playCount - a.playCount ||
    b.distinctListeningDays - a.distinctListeningDays ||
    a.artistName.localeCompare(b.artistName);
  const topArtistsHistorical = sorted(artistProfiles, byHistorical);

  const byTrackHistory = (a: DiscoveryTrackProfile, b: DiscoveryTrackProfile) =>
    b.playCount - a.playCount ||
    b.distinctListeningDays - a.distinctListeningDays ||
    `${a.artistName}\u0000${a.trackName}`.localeCompare(
      `${b.artistName}\u0000${b.trackName}`,
    );
  const topTracksHistorical = sorted(trackProfiles, byTrackHistory);

  return {
    generatedAt: asOf,
    heuristics: {
      dormantDays,
      rediscoveryGapDays,
      momentumMinListeningDays: MIN_MOMENTUM_LISTENING_DAYS,
      rediscoveryMinPriorPlays: MIN_REDISCOVERY_PRIOR_PLAYS,
      rediscoveryMinRecentPlays: MIN_REDISCOVERY_RECENT_PLAYS,
      note:
        "Gate 1.1 applies conservative profile hygiene and transparent ranking thresholds only; final preference weights are intentionally not defined yet.",
    },
    coverage: {
      firstPlayedAt: state.firstPlayedAt,
      lastPlayedAt: state.lastPlayedAt,
      lastFmValidFrom,
      totalCanonicalEvents: state.totalCanonicalEvents,
      invalidLegacyLastFmExcluded: state.invalidLegacyLastFmExcluded,
      invalidSyntheticEpochEventsExcluded:
        state.invalidSyntheticEpochEventsExcluded,
      futureEventsExcluded: state.futureEventsExcluded,
      nonMusicalProfileEventsExcluded: state.nonMusicalProfileEventsExcluded,
      artistAliasEventsCanonicalized: state.artistAliasEventsCanonicalized,
      sourceCounts: [...state.sourceCounts.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => a.source.localeCompare(b.source)),
      canonicalSpotifyIdentityEvents: state.canonicalSpotifyIdentityEvents,
      unresolvedIdentityEvents: state.unresolvedIdentityEvents,
      extendedEvidenceEvents: state.extendedEvidenceEvents,
      msPlayedEvidenceEvents: state.msPlayedEvidenceEvents,
      explicitSkipEvents: state.explicitSkipEvents,
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
      trackedStateCount: trackStates.length,
      timelineFallbackTrackCount,
      timelineOverrideTrackCount,
      blockedTrackCount,
    },
    topArtistsHistorical,
    topTracksHistorical,
    artistProfiles,
    trackProfiles,
  };
}

function finalizeRetainedProfile(
  input: FinalizeProfileInput,
): RetainedCompleteMusicDiscoveryProfile {
  const prepared = prepareFinalizedProfile(input);
  return {
    generatedAt: prepared.generatedAt,
    heuristics: prepared.heuristics,
    coverage: prepared.coverage,
    cooldown: prepared.cooldown,
    topArtistsHistorical: prepared.topArtistsHistorical,
    topTracksHistorical: prepared.topTracksHistorical,
  };
}

function finalizeProfile(input: FinalizeProfileInput): MusicDiscoveryProfile {
  const prepared = prepareFinalizedProfile(input);
  const { artistProfiles, trackProfiles } = prepared;
  const dormantCutoff = daysBefore(
    prepared.generatedAt,
    prepared.heuristics.dormantDays,
  );

  const byHistorical = (a: DiscoveryArtistProfile, b: DiscoveryArtistProfile) =>
    b.playCount - a.playCount ||
    b.distinctListeningDays - a.distinctListeningDays ||
    a.artistName.localeCompare(b.artistName);
  const byWindow = (field: "plays30d" | "plays90d" | "plays365d") =>
    (a: DiscoveryArtistProfile, b: DiscoveryArtistProfile) =>
      b[field] - a[field] || byHistorical(a, b);

  const topArtists30d = sorted(
    artistProfiles.filter((artist) => artist.plays30d > 0),
    byWindow("plays30d"),
  );
  const topArtists90d = sorted(
    artistProfiles.filter((artist) => artist.plays90d > 0),
    byWindow("plays90d"),
  );
  const topArtists365d = sorted(
    artistProfiles.filter((artist) => artist.plays365d > 0),
    byWindow("plays365d"),
  );
  const recentMomentum = sorted(
    artistProfiles.filter(
      (artist) =>
        artist.plays30d > 0 &&
        artist.momentumDelta30d > 0 &&
        artist.listeningDays30d >= MIN_MOMENTUM_LISTENING_DAYS,
    ),
    (a, b) =>
      b.momentumDelta30d - a.momentumDelta30d ||
      b.listeningDays30d - a.listeningDays30d ||
      b.plays30d - a.plays30d ||
      byHistorical(a, b),
  );
  const dormantFavorites = sorted(
    artistProfiles.filter((artist) => artist.lastPlayedAt < dormantCutoff),
    byHistorical,
  );
  const rediscoveryReturns = sorted(
    artistProfiles.filter(
      (artist) =>
        artist.plays30d >= MIN_REDISCOVERY_RECENT_PLAYS &&
        artist.priorPlayCount >= MIN_REDISCOVERY_PRIOR_PLAYS &&
        (artist.rediscoveryGapDays ?? 0) >= prepared.heuristics.rediscoveryGapDays,
    ),
    (a, b) =>
      b.priorPlayCount - a.priorPlayCount ||
      b.plays30d - a.plays30d ||
      (b.rediscoveryGapDays ?? 0) - (a.rediscoveryGapDays ?? 0) ||
      byHistorical(a, b),
  );

  const byTrackHistory = (a: DiscoveryTrackProfile, b: DiscoveryTrackProfile) =>
    b.playCount - a.playCount ||
    b.distinctListeningDays - a.distinctListeningDays ||
    `${a.artistName}\u0000${a.trackName}`.localeCompare(
      `${b.artistName}\u0000${b.trackName}`,
    );
  const familiarCandidates = sorted(
    trackProfiles.filter((track) => track.cooldownEligible === true),
    byTrackHistory,
  );
  const rediscoveryCandidates = sorted(
    trackProfiles.filter(
      (track) => track.cooldownEligible === true && track.lastPlayedAt < dormantCutoff,
    ),
    byTrackHistory,
  );

  return {
    generatedAt: prepared.generatedAt,
    heuristics: prepared.heuristics,
    coverage: prepared.coverage,
    cooldown: prepared.cooldown,
    topArtistsHistorical: prepared.topArtistsHistorical,
    topArtists30d,
    topArtists90d,
    topArtists365d,
    recentMomentum,
    dormantFavorites,
    rediscoveryReturns,
    topTracksHistorical: prepared.topTracksHistorical,
    familiarCandidates,
    rediscoveryCandidates,
  };
}

function artistIdentity(value: string): ArtistIdentity {
  const rawKey = normalized(value);
  const key = ARTIST_ALIAS_KEYS.get(rawKey) ?? rawKey;
  const canonicalLabel = CANONICAL_ARTIST_LABELS.get(key);
  return {
    key,
    displayName: canonicalLabel ?? value.trim(),
    canonicalized: key !== rawKey,
    canonicalLabelLocked: Boolean(canonicalLabel),
  };
}

function isNonMusicalProfileEvent(event: DiscoveryHistoryEvent): boolean {
  return NON_MUSICAL_ARTIST_KEYS.has(normalized(event.artistName));
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
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function ratioOrNull(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * DAY_MS);
}

function utcEpochDay(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

function wholeDaysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / DAY_MS));
}

function sorted<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare);
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
