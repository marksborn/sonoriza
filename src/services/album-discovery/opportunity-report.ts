import { prisma } from "@/lib/prisma";
import {
  buildHistoricalArtistIdentityEvidence,
  type HistoricalArtistIdentityEvidence,
} from "@/services/album-discovery/artist-identity";
import {
  ALBUM_OPPORTUNITY_POLICY,
  rankAlbumOpportunities,
  scoreAlbumOpportunity,
  type AlbumOpportunityCandidate,
} from "@/services/album-discovery/opportunity";
import { buildAlbumCoverageFacts, type AlbumHistoryEvent } from "@/services/album-discovery/profile";
import {
  ALBUM_QUEUE_MEMORY_POLICY,
  loadAlbumRecommendationMemories,
  suppressQueuedAlbumOpportunities,
} from "@/services/album-discovery/queue-memory";
import { SpotifyAlbumCatalogClient } from "@/services/spotify/album-catalog";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "@/services/music-discovery/profile";
import { buildDiscoveryGate22ScoringReport } from "@/services/music-discovery/scoring-gate2-2";
import { resolveExternalDiscoveryCandidate } from "@/services/music-discovery/spotify-resolution";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";

const DEFAULT_PROFILE_POOL_SIZE = 100;
const ALBUM_TRACK_CONCURRENCY = 6;
const REPORT_CACHE_TTL_MS = 5 * 60_000;

type AlbumOpportunityReport = Awaited<ReturnType<typeof computeAlbumOpportunityReport>>;

type AlbumOpportunityReportCacheEntry = {
  expiresAt: number;
  promise: Promise<AlbumOpportunityReport>;
};

const reportCache = new Map<string, AlbumOpportunityReportCacheEntry>();

export type AlbumOpportunityReportOptions = {
  asOf?: Date;
  artistLimit?: number;
  top?: number;
  profilePoolSize?: number;
};

export type AlbumOpportunityArtistReport = {
  artistName: string;
  artistDeepeningScore: number;
  historicalArtistIdentity: HistoricalArtistIdentityEvidence;
  resolutionStatus: string;
  resolutionReason: string;
  spotifyArtist?: { id: string; name: string };
  catalogAlbumCount: number;
  scoredAlbumCount: number;
};

export type AlbumOpportunityProviderFailure = {
  subject: string;
  error: string;
};

export async function getAlbumOpportunityReport(
  userId: string,
  options: AlbumOpportunityReportOptions = {},
): Promise<AlbumOpportunityReport> {
  if (options.asOf) {
    return computeAlbumOpportunityReport(userId, options);
  }

  const artistLimit = clampInteger(options.artistLimit ?? 5, 1, 20);
  const top = clampInteger(options.top ?? 20, 1, 100);
  const profilePoolSize = clampInteger(
    options.profilePoolSize ?? DEFAULT_PROFILE_POOL_SIZE,
    20,
    500,
  );
  const cacheKey = `${userId}:${artistLimit}:${top}:${profilePoolSize}`;
  const now = Date.now();
  const cached = reportCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = computeAlbumOpportunityReport(userId, {
    artistLimit,
    top,
    profilePoolSize,
  }).catch((error) => {
    reportCache.delete(cacheKey);
    throw error;
  });

  reportCache.set(cacheKey, {
    expiresAt: now + REPORT_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

async function computeAlbumOpportunityReport(
  userId: string,
  options: AlbumOpportunityReportOptions = {},
) {
  const asOf = options.asOf ?? new Date();
  const artistLimit = clampInteger(options.artistLimit ?? 5, 1, 20);
  const top = clampInteger(options.top ?? 20, 1, 100);
  const profilePoolSize = clampInteger(
    options.profilePoolSize ?? DEFAULT_PROFILE_POOL_SIZE,
    20,
    500,
  );

  const [profile, trackIdentities, albumMemories] = await Promise.all([
    getMusicDiscoveryProfile(userId, { asOf, topN: profilePoolSize }),
    getDiscoveryTrackIdentityEvidence(userId),
    loadAlbumRecommendationMemories(userId),
  ]);

  const artists = uniqueArtists([
    ...profile.topArtistsHistorical,
    ...profile.topArtists30d,
    ...profile.topArtists90d,
    ...profile.topArtists365d,
    ...profile.recentMomentum,
    ...profile.dormantFavorites,
    ...profile.rediscoveryReturns,
  ]);
  const tracks = uniqueTracks([
    ...profile.topTracksHistorical,
    ...profile.familiarCandidates,
    ...profile.rediscoveryCandidates,
  ]);
  const discovery = buildDiscoveryGate22ScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: profilePoolSize,
    artists,
    tracks,
    trackIdentities,
    candidateUniverse: "DIAGNOSTIC_PARTIAL",
  });

  const search = await SpotifyCatalogSearchClient.forUser(userId);
  const albumCatalog = await SpotifyAlbumCatalogClient.forUser(userId);
  const selectedArtists = discovery.deepeningCandidates.slice(0, artistLimit);
  const candidates: AlbumOpportunityCandidate[] = [];
  const artistReports: AlbumOpportunityArtistReport[] = [];
  const failures: AlbumOpportunityProviderFailure[] = [];

  for (const artistCandidate of selectedArtists) {
    const identity = await loadHistoricalArtistIdentity({
      userId,
      artistName: artistCandidate.artistName,
      asOf,
    });
    const resolution = await resolveExternalDiscoveryCandidate(search, {
      candidateKey: `album-opportunity:${normalized(artistCandidate.artistName)}`,
      candidateType: "ARTIST",
      artistName: artistCandidate.artistName,
      trackName: null,
      preferredSpotifyArtistId: identity.primaryArtistId,
    });

    if (resolution.status !== "RESOLVED" || !resolution.spotifyArtist) {
      artistReports.push({
        artistName: artistCandidate.artistName,
        artistDeepeningScore: artistCandidate.score,
        historicalArtistIdentity: identity,
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        catalogAlbumCount: 0,
        scoredAlbumCount: 0,
      });
      continue;
    }

    const spotifyArtist = resolution.spotifyArtist;
    try {
      const [catalogAlbums, events] = await Promise.all([
        albumCatalog.listArtistAlbums(spotifyArtist.id),
        loadArtistHistoryEvents({
          userId,
          spotifyArtistId: spotifyArtist.id,
          requestedArtistName: artistCandidate.artistName,
          resolvedArtistName: spotifyArtist.name,
          asOf,
        }),
      ]);

      const albumResults = await mapWithConcurrency(
        catalogAlbums,
        ALBUM_TRACK_CONCURRENCY,
        async (album) => {
          try {
            const albumTracks = await albumCatalog.getAlbumTracks(album.id);
            const coverage = buildAlbumCoverageFacts({
              album,
              tracks: albumTracks,
              events,
              spotifyArtistId: spotifyArtist.id,
              spotifyArtistName: spotifyArtist.name,
              asOf,
            });
            return {
              scored: scoreAlbumOpportunity({
                artistName: artistCandidate.artistName,
                artistDeepeningScore: artistCandidate.score,
                coverage,
              }),
              failure: null,
            };
          } catch (error) {
            return {
              scored: null,
              failure: {
                subject: `${artistCandidate.artistName}:${album.name}:${album.id}`,
                error: errorMessage(error),
              } satisfies AlbumOpportunityProviderFailure,
            };
          }
        },
      );

      let scoredAlbumCount = 0;
      for (const result of albumResults) {
        if (result.failure) failures.push(result.failure);
        if (!result.scored) continue;
        candidates.push(result.scored);
        if (result.scored.eligible) scoredAlbumCount += 1;
      }

      artistReports.push({
        artistName: artistCandidate.artistName,
        artistDeepeningScore: artistCandidate.score,
        historicalArtistIdentity: identity,
        resolutionStatus: resolution.status,
        resolutionReason: resolution.reason,
        spotifyArtist: { id: spotifyArtist.id, name: spotifyArtist.name },
        catalogAlbumCount: catalogAlbums.length,
        scoredAlbumCount,
      });
    } catch (error) {
      failures.push({
        subject: `${artistCandidate.artistName}:catalog`,
        error: errorMessage(error),
      });
    }
  }

  const memoryApplied = suppressQueuedAlbumOpportunities(candidates, albumMemories);
  const ranked = rankAlbumOpportunities(memoryApplied.candidates);
  const queuedMemoryCount = albumMemories.filter((memory) => memory.state === "QUEUED").length;

  return {
    generatedAt: new Date(),
    asOf,
    policy: ALBUM_OPPORTUNITY_POLICY,
    queueMemoryPolicy: ALBUM_QUEUE_MEMORY_POLICY,
    discoveryProfile: {
      scoringVersion: discovery.version,
      note:
        "DISCOVERY-01 deepening score is reused as the artist component. ALBUM-01 adds only album-specific facts.",
    },
    scope: {
      requestedArtistCount: artistLimit,
      selectedArtistCount: selectedArtists.length,
      catalogScope: "ALL_FULL_ALBUM_EDITIONS_FOR_RESOLVED_ARTISTS" as const,
      editionIdentity: "SPOTIFY_ALBUM_ID" as const,
      topOutput: top,
    },
    queueMemory: {
      persistedRecordCount: albumMemories.length,
      queuedCount: queuedMemoryCount,
      suppressedAlbumCount: memoryApplied.suppressedAlbumIds.length,
      suppressedAlbumIds: memoryApplied.suppressedAlbumIds,
    },
    artistReports,
    candidateCount: ranked.length,
    ranked: ranked.slice(0, top),
    providerMetrics: {
      search: search.getMetrics(),
      albumCatalog: albumCatalog.getMetrics(),
      failures,
    },
    safety: {
      spotifyWrites: 0 as const,
      databaseWrites: 0 as const,
      queueWrites: 0 as const,
      music01Changed: false as const,
      tiaoBrainRequired: false as const,
    },
  };
}

async function loadHistoricalArtistIdentity(input: {
  userId: string;
  artistName: string;
  asOf: Date;
}): Promise<HistoricalArtistIdentityEvidence> {
  const rows = await prisma.trackListeningEvent.groupBy({
    by: ["primaryArtistId"],
    where: {
      userId: input.userId,
      playedAt: { lte: input.asOf },
      primaryArtistId: { not: null },
      artistName: { equals: input.artistName, mode: "insensitive" },
    },
    _count: { _all: true },
  });
  return buildHistoricalArtistIdentityEvidence(
    rows.map((row) => ({
      primaryArtistId: row.primaryArtistId,
      eventCount: row._count._all,
    })),
  );
}

async function loadArtistHistoryEvents(input: {
  userId: string;
  spotifyArtistId: string;
  requestedArtistName: string;
  resolvedArtistName: string;
  asOf: Date;
}): Promise<AlbumHistoryEvent[]> {
  const artistNames = [...new Set([input.requestedArtistName, input.resolvedArtistName])];
  return prisma.trackListeningEvent.findMany({
    where: {
      userId: input.userId,
      playedAt: { lte: input.asOf },
      OR: [
        { primaryArtistId: input.spotifyArtistId },
        ...artistNames.map((artistName) => ({
          primaryArtistId: null,
          artistName: { equals: artistName, mode: "insensitive" as const },
        })),
      ],
    },
    select: {
      spotifyTrackId: true,
      trackName: true,
      artistName: true,
      primaryArtistId: true,
      albumName: true,
      albumId: true,
      playedAt: true,
      source: true,
      metadata: true,
    },
    orderBy: { playedAt: "asc" },
  });
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(items.length, Math.trunc(concurrency)));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function uniqueArtists(rows: DiscoveryArtistProfile[]): DiscoveryArtistProfile[] {
  const byName = new Map<string, DiscoveryArtistProfile>();
  for (const row of rows) {
    const key = normalized(row.artistName);
    if (!byName.has(key)) byName.set(key, row);
  }
  return [...byName.values()];
}

function uniqueTracks(rows: DiscoveryTrackProfile[]): DiscoveryTrackProfile[] {
  const byId = new Map<string, DiscoveryTrackProfile>();
  for (const row of rows) byId.set(row.spotifyTrackId, row);
  return [...byId.values()];
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
