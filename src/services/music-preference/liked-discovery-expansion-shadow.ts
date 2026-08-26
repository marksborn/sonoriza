import { ArtistSimilarityProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getForYouReport } from "@/services/music-discovery/for-you-report";
import {
  scoreExternalDiscoveryCandidate,
  type ExternalDiscoveryCandidateScore,
} from "@/services/music-discovery/scoring";
import {
  resolveExternalDiscoveryCandidate,
  type SpotifyDiscoveryResolution,
} from "@/services/music-discovery/spotify-resolution";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";

import {
  buildLikedShadowDiscoveryComparison,
  type LikedDirectAffinitySignal,
  type LikedShadowRankedRecommendation,
  type LikedSimilaritySignal,
} from "./liked-shadow-discovery";

export const LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY = {
  poolPerCategory: 12,
  topPerCategory: 4,
  historyProbeLimit: 120,
  resolutionCandidateBudget: 20,
  targetResolvedCandidates: 8,
  maxPerDominantSeed: 2,
  sourceConfidence: 0.9,
  likedArtistAffinityBase: 0.65,
  likedArtistAffinityPerDoubling: 0.1,
  likedArtistAffinityMax: 1,
} as const;

export type LikedExpansionSimilaritySignal = LikedSimilaritySignal & {
  candidateArtistMbid?: string | null;
};

export type LikedExpansionAggregate = {
  candidateKey: string;
  candidateArtistMbid: string | null;
  artistName: string;
  normalizedArtistName: string;
  maxSimilarity: number;
  supportingSeeds: number;
  seedArtistNames: string[];
  dominantSeed: {
    spotifyArtistId: string;
    artistName: string;
    likedTrackCount: number;
    affinity: number;
    similarity: number;
  };
  scoreCard: ExternalDiscoveryCandidateScore;
};

export type LikedExpansionResolvedCandidate = LikedExpansionAggregate & {
  providerArtistName: string;
  spotifyArtistId: string;
  spotifyTrackId: string;
  trackName: string;
  albumName: string | null;
  resolutionReason: string;
};

export type LikedExpandedDiscoveryTopEntry =
  | {
      source: "CURRENT_POOL";
      artistName: string;
      trackName: string;
      spotifyTrackId: string | null;
      rankingScore: number;
      displayScore: number;
      signalKind: LikedShadowRankedRecommendation["signalKind"];
      explanation: string | null;
    }
  | {
      source: "LIKED_EXPANSION";
      artistName: string;
      trackName: string;
      spotifyTrackId: string;
      rankingScore: number;
      displayScore: number;
      signalKind: "SIMILAR_EXPLORATORY";
      explanation: string;
    };

export type LikedDiscoveryExpansionShadowReport = {
  generatedAt: Date;
  policy: typeof LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY;
  safety: {
    shadowOnly: true;
    databaseWrites: false;
    plannerInfluence: false;
    spotifyWrites: false;
    expansionLastFmCalls: 0;
  };
  baseline: {
    externalStatus: string;
    providerFailures: number;
    discoveryPoolSize: number;
    top: LikedShadowRankedRecommendation[];
  };
  likedOverlay: {
    top: LikedShadowRankedRecommendation[];
  };
  graph: {
    directAffinityArtists: number;
    activeSeedArtists: number;
    activeSimilarityEdges: number;
    aggregateArtistNames: number;
    ambiguousSimilarityArtistNames: number;
    excludedDirectArtistNames: number;
    excludedAlreadyRepresentedArtistNames: number;
    historyProbedArtistNames: number;
    rejectedKnownHistoryArtistNames: number;
    eligibleResolutionCandidates: number;
    selectedResolutionCandidates: number;
  };
  resolution: {
    attempted: number;
    resolved: number;
    ambiguous: number;
    notFound: number;
    rejectedResolvedDirectArtists: number;
    rejectedResolvedRepresentedArtists: number;
    rejectedResolvedHistoricalArtists: number;
    failures: Array<{ candidateKey: string; error: string }>;
    spotifyCatalogCalls: number;
    spotifyFailures: number;
    spotifyRateLimits: number;
    spotifyRetries: number;
  };
  resolvedCandidates: LikedExpansionResolvedCandidate[];
  expandedTop: LikedExpandedDiscoveryTopEntry[];
  changes: {
    entrantsVsBaseline: LikedExpandedDiscoveryTopEntry[];
    exitsVsBaseline: LikedShadowRankedRecommendation[];
    entrantsVsLikedOverlay: LikedExpandedDiscoveryTopEntry[];
    exitsVsLikedOverlay: LikedShadowRankedRecommendation[];
  };
};

type MutableAggregate = {
  candidateKeys: Set<string>;
  candidateArtistMbids: Set<string>;
  artistName: string;
  normalizedArtistName: string;
  maxSimilarity: number;
  seedArtistNames: Map<string, string>;
  bestSeed: LikedExpansionAggregate["dominantSeed"] | null;
};

export async function getLikedDiscoveryExpansionShadowReport(
  userId: string,
): Promise<LikedDiscoveryExpansionShadowReport> {
  const baseline = await getForYouReport(userId, {
    limitPerCategory: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.poolPerCategory,
    externalReferenceLimit: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.topPerCategory,
  });

  const [
    directAffinities,
    activeSeeds,
    similarityEdges,
    historicalSpotifyArtists,
    historicalArtistNames,
  ] = await Promise.all([
    prisma.artistAffinityState.findMany({
      where: { userId, active: true },
      select: {
        spotifyArtistId: true,
        artistName: true,
        likedTrackCount: true,
      },
    }),
    prisma.artistSimilaritySeedState.findMany({
      where: {
        userId,
        provider: ArtistSimilarityProvider.LASTFM,
        active: true,
      },
      select: { sourceSpotifyArtistId: true },
    }),
    prisma.artistSimilarityEdge.findMany({
      where: {
        userId,
        provider: ArtistSimilarityProvider.LASTFM,
        active: true,
      },
      select: {
        candidateKey: true,
        candidateArtistName: true,
        candidateArtistMbid: true,
        sourceSpotifyArtistId: true,
        sourceArtistName: true,
        similarity: true,
      },
    }),
    // Keep canonical-history identity aggregation in PostgreSQL. Prisma's
    // client-side distinct can otherwise materialize one row per listening event.
    prisma.trackListeningEvent.groupBy({
      by: ["primaryArtistId"],
      where: { userId, primaryArtistId: { not: null } },
    }),
    prisma.trackListeningEvent.groupBy({
      by: ["artistName"],
      where: { userId },
    }),
  ]);

  const activeSeedCount = new Set(activeSeeds.map((row) => row.sourceSpotifyArtistId)).size;
  const likedOverlay = buildLikedShadowDiscoveryComparison({
    baseline,
    directAffinities,
    similarityEdges,
    activeSeedCount,
    poolPerCategory: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.poolPerCategory,
    topPerCategory: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.topPerCategory,
  });

  const representedArtistNames = new Set(
    baseline.discovery.map((row) => normalized(row.artistName)),
  );
  const ranked = rankLikedExpansionAggregates({
    directAffinities,
    similarityEdges,
    representedArtistNames,
  });
  // Build the history probe from the full ranked graph with seed round-robin
  // diversity before truncation. Otherwise one prolific seed can consume the
  // whole probe window and hide strong candidates from other affinity paths.
  const probes = buildDiverseHistoryProbe(
    ranked.rows,
    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.historyProbeLimit,
  );
  const history = await getArtistHistoryCounts(userId, probes);
  const selection = selectLikedExpansionResolutionCandidates({
    rows: probes,
    historyByNormalizedArtistName: history,
    budget: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.resolutionCandidateBudget,
    maxPerDominantSeed: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.maxPerDominantSeed,
  });

  const spotify = await SpotifyCatalogSearchClient.forUser(userId);
  const directSpotifyArtistIds = new Set(
    directAffinities.map((row) => row.spotifyArtistId),
  );
  const historicalSpotifyArtistIds = new Set(
    historicalSpotifyArtists
      .map((row) => row.primaryArtistId)
      .filter((value): value is string => Boolean(value)),
  );
  const historicalNormalizedArtistNames = new Set(
    historicalArtistNames
      .map((row) => normalized(row.artistName))
      .filter(Boolean),
  );
  const baselineTrackIds = new Set(
    baseline.discovery
      .map((row) => row.spotifyTrackId)
      .filter((value): value is string => Boolean(value)),
  );
  const resolvedCandidates: LikedExpansionResolvedCandidate[] = [];
  const failures: Array<{ candidateKey: string; error: string }> = [];
  const seenTrackIds = new Set<string>();
  let attempted = 0;
  let ambiguous = 0;
  let notFound = 0;
  let rejectedResolvedDirectArtists = 0;
  let rejectedResolvedRepresentedArtists = 0;
  let rejectedResolvedHistoricalArtists = 0;

  for (const candidate of selection.selected) {
    if (
      resolvedCandidates.length >=
      LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.targetResolvedCandidates
    ) {
      break;
    }
    attempted += 1;
    try {
      const resolution = await resolveExternalDiscoveryCandidate(spotify, {
        candidateKey: candidate.candidateKey,
        candidateType: "ARTIST",
        artistName: candidate.artistName,
        trackName: null,
      });
      if (resolution.status === "AMBIGUOUS") {
        ambiguous += 1;
        continue;
      }
      if (resolution.status === "NOT_FOUND") {
        notFound += 1;
        continue;
      }
      if (!resolution.spotifyArtist || !resolution.spotifyTrack) continue;
      // Name aliases are only an acquisition hint. Canonical Spotify identity is
      // authoritative after resolution, so a directly liked artist can never be
      // reintroduced as exploratory under another spelling (for example The X/X).
      if (
        isResolvedDirectAffinityArtist(
          resolution.spotifyArtist.id,
          directSpotifyArtistIds,
        )
      ) {
        rejectedResolvedDirectArtists += 1;
        continue;
      }
      const resolvedArtistName = normalized(resolution.spotifyArtist.name);
      // Reapply baseline artist exclusion after Spotify canonicalizes aliases.
      // Controlled leading-article equivalence is symmetric: both X -> The X
      // and The X -> X must remain the same discovery identity.
      if (hasEquivalentArtistName(representedArtistNames, resolvedArtistName)) {
        rejectedResolvedRepresentedArtists += 1;
        continue;
      }
      // Last.fm names/MBIDs are pre-resolution evidence. Once Spotify gives us
      // canonical identity, reject any artist already present in canonical
      // listening history by Spotify ID or canonicalized name. The name fallback
      // protects older history rows that do not have primaryArtistId populated.
      if (
        isResolvedHistoricalArtist(
          resolution.spotifyArtist.id,
          resolvedArtistName,
          historicalSpotifyArtistIds,
          historicalNormalizedArtistNames,
        )
      ) {
        rejectedResolvedHistoricalArtists += 1;
        continue;
      }
      if (baselineTrackIds.has(resolution.spotifyTrack.id)) continue;
      if (seenTrackIds.has(resolution.spotifyTrack.id)) continue;
      seenTrackIds.add(resolution.spotifyTrack.id);
      resolvedCandidates.push(
  materializeResolvedExpansionCandidate(candidate, resolution),
);
    } catch (error) {
      failures.push({
        candidateKey: candidate.candidateKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const expandedTop = buildLikedExpandedDiscoveryTop({
    currentTop: likedOverlay.categories.discovery.shadow,
    expansions: resolvedCandidates,
    topN: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.topPerCategory,
  });
  const baselineTop = likedOverlay.categories.discovery.baseline;
  const likedTop = likedOverlay.categories.discovery.shadow;
  const spotifyMetrics = spotify.getMetrics();

  return {
    generatedAt: new Date(),
    policy: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY,
    safety: {
      shadowOnly: true,
      databaseWrites: false,
      plannerInfluence: false,
      spotifyWrites: false,
      expansionLastFmCalls: 0,
    },
    baseline: {
      externalStatus: baseline.external.status,
      providerFailures: baseline.external.providerFailures,
      discoveryPoolSize: baseline.discovery.length,
      top: baselineTop,
    },
    likedOverlay: { top: likedTop },
    graph: {
      directAffinityArtists: directAffinities.length,
      activeSeedArtists: activeSeedCount,
      activeSimilarityEdges: similarityEdges.length,
      aggregateArtistNames: ranked.metrics.aggregateArtistNames,
      ambiguousSimilarityArtistNames: ranked.metrics.ambiguousSimilarityArtistNames,
      excludedDirectArtistNames: ranked.metrics.excludedDirectArtistNames,
      excludedAlreadyRepresentedArtistNames:
        ranked.metrics.excludedAlreadyRepresentedArtistNames,
      historyProbedArtistNames: probes.length,
      rejectedKnownHistoryArtistNames: selection.rejectedKnownHistoryArtistNames,
      eligibleResolutionCandidates: selection.eligibleCount,
      selectedResolutionCandidates: selection.selected.length,
    },
    resolution: {
      attempted,
      resolved: resolvedCandidates.length,
      ambiguous,
      notFound,
      rejectedResolvedDirectArtists,
      rejectedResolvedRepresentedArtists,
      rejectedResolvedHistoricalArtists,
      failures,
      spotifyCatalogCalls: spotifyMetrics.totalCalls,
      spotifyFailures: spotifyMetrics.failures,
      spotifyRateLimits: spotifyMetrics.rateLimitedCount,
      spotifyRetries: spotifyMetrics.retries,
    },
    resolvedCandidates,
    expandedTop,
    changes: {
      entrantsVsBaseline: entrants(expandedTop, baselineTop),
      exitsVsBaseline: exits(expandedTop, baselineTop),
      entrantsVsLikedOverlay: entrants(expandedTop, likedTop),
      exitsVsLikedOverlay: exits(expandedTop, likedTop),
    },
  };
}

export function rankLikedExpansionAggregates(input: {
  directAffinities: LikedDirectAffinitySignal[];
  similarityEdges: LikedExpansionSimilaritySignal[];
  representedArtistNames?: Set<string>;
}): {
  rows: LikedExpansionAggregate[];
  metrics: {
    aggregateArtistNames: number;
    ambiguousSimilarityArtistNames: number;
    excludedDirectArtistNames: number;
    excludedAlreadyRepresentedArtistNames: number;
  };
} {
  const directById = new Map(
    input.directAffinities.map((row) => [row.spotifyArtistId, row] as const),
  );
  const directNames = new Set(
    input.directAffinities
      .map((row) => normalized(row.artistName ?? ""))
      .filter(Boolean),
  );
  const represented = input.representedArtistNames ?? new Set<string>();
  const aggregates = new Map<string, MutableAggregate>();

  for (const edge of input.similarityEdges) {
    const source = directById.get(edge.sourceSpotifyArtistId);
    if (!source || !source.artistName || source.likedTrackCount < 1) continue;
    const key = normalized(edge.candidateArtistName);
    if (!key) continue;
    const seedAffinity = likedTrackCountAffinity(source.likedTrackCount);
    const seed = {
      spotifyArtistId: source.spotifyArtistId,
      artistName: source.artistName,
      likedTrackCount: source.likedTrackCount,
      affinity: seedAffinity,
      similarity: edge.similarity,
    };
    const current = aggregates.get(key) ?? {
      candidateKeys: new Set<string>(),
      candidateArtistMbids: new Set<string>(),
      artistName: edge.candidateArtistName,
      normalizedArtistName: key,
      maxSimilarity: 0,
      seedArtistNames: new Map<string, string>(),
      bestSeed: null,
    };
    current.candidateKeys.add(edge.candidateKey);
    if (edge.candidateArtistMbid?.trim()) {
      current.candidateArtistMbids.add(edge.candidateArtistMbid.trim().toLowerCase());
    }
    current.maxSimilarity = Math.max(current.maxSimilarity, edge.similarity);
    current.seedArtistNames.set(source.spotifyArtistId, source.artistName);
    if (!current.bestSeed || betterSeed(seed, current.bestSeed)) current.bestSeed = seed;
    aggregates.set(key, current);
  }

  let ambiguousSimilarityArtistNames = 0;
  let excludedDirectArtistNames = 0;
  let excludedAlreadyRepresentedArtistNames = 0;
  const rows: LikedExpansionAggregate[] = [];

  for (const aggregate of aggregates.values()) {
    if (
      aggregate.candidateKeys.size !== 1 ||
      aggregate.candidateArtistMbids.size > 1
    ) {
      ambiguousSimilarityArtistNames += 1;
      continue;
    }
    if (directNames.has(aggregate.normalizedArtistName)) {
      excludedDirectArtistNames += 1;
      continue;
    }
    if (represented.has(aggregate.normalizedArtistName)) {
      excludedAlreadyRepresentedArtistNames += 1;
      continue;
    }
    if (!aggregate.bestSeed) continue;
    const candidateKey = [...aggregate.candidateKeys][0]!;
    const scoreCard = scoreExternalDiscoveryCandidate({
      candidateKey,
      artistName: aggregate.artistName,
      source: "LASTFM_SIMILAR_ARTIST",
      // Do not synthesize a stronger path by combining similarity from one
      // seed with explicit affinity from another. The dominant evidence path
      // supplies both terms; multi-seed support remains an audit/tie-break signal.
      similarity: aggregate.bestSeed.similarity,
      seedArtistAffinity: aggregate.bestSeed.affinity,
      sourceConfidence: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.sourceConfidence,
      knownHistoricalPlayCount: 0,
    });
    rows.push({
      candidateKey,
      candidateArtistMbid:
        aggregate.candidateArtistMbids.size === 1
          ? [...aggregate.candidateArtistMbids][0]!
          : null,
      artistName: aggregate.artistName,
      normalizedArtistName: aggregate.normalizedArtistName,
      maxSimilarity: aggregate.maxSimilarity,
      supportingSeeds: aggregate.seedArtistNames.size,
      seedArtistNames: [...aggregate.seedArtistNames.values()].sort((a, b) =>
        a.localeCompare(b),
      ),
      dominantSeed: aggregate.bestSeed,
      scoreCard,
    });
  }

  rows.sort(compareExpansionRows);
  return {
    rows,
    metrics: {
      aggregateArtistNames: aggregates.size,
      ambiguousSimilarityArtistNames,
      excludedDirectArtistNames,
      excludedAlreadyRepresentedArtistNames,
    },
  };
}

export function selectLikedExpansionResolutionCandidates(input: {
  rows: LikedExpansionAggregate[];
  historyByNormalizedArtistName: Map<string, number>;
  budget: number;
  maxPerDominantSeed: number;
}): {
  selected: LikedExpansionAggregate[];
  eligibleCount: number;
  rejectedKnownHistoryArtistNames: number;
} {
  if (!Number.isInteger(input.budget) || input.budget < 1) {
    throw new Error("resolution budget must be a positive integer");
  }
  if (!Number.isInteger(input.maxPerDominantSeed) || input.maxPerDominantSeed < 1) {
    throw new Error("maxPerDominantSeed must be a positive integer");
  }

  const rescored = input.rows.map((row) => {
    const knownHistoricalPlayCount =
      input.historyByNormalizedArtistName.get(row.normalizedArtistName) ?? 0;
    return {
      row: {
        ...row,
        scoreCard: scoreExternalDiscoveryCandidate({
          candidateKey: row.candidateKey,
          artistName: row.artistName,
          source: "LASTFM_SIMILAR_ARTIST",
          similarity: row.dominantSeed.similarity,
          seedArtistAffinity: row.dominantSeed.affinity,
          sourceConfidence: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.sourceConfidence,
          knownHistoricalPlayCount,
        }),
      },
      knownHistoricalPlayCount,
    };
  });
  const eligible = rescored
    .filter((entry) => entry.row.scoreCard.eligible)
    .map((entry) => entry.row)
    .sort(compareExpansionRows);
  const selected: LikedExpansionAggregate[] = [];
  const perSeed = new Map<string, number>();

  for (const row of eligible) {
    const seedId = row.dominantSeed.spotifyArtistId;
    const used = perSeed.get(seedId) ?? 0;
    if (used >= input.maxPerDominantSeed) continue;
    selected.push(row);
    perSeed.set(seedId, used + 1);
    if (selected.length >= input.budget) break;
  }

  return {
    selected,
    eligibleCount: eligible.length,
    rejectedKnownHistoryArtistNames: rescored.filter(
      (entry) => entry.knownHistoricalPlayCount > 0,
    ).length,
  };
}

export function buildLikedExpandedDiscoveryTop(input: {
  currentTop: LikedShadowRankedRecommendation[];
  expansions: LikedExpansionResolvedCandidate[];
  topN: number;
}): LikedExpandedDiscoveryTopEntry[] {
  if (!Number.isInteger(input.topN) || input.topN < 1) {
    throw new Error("topN must be a positive integer");
  }
  const rows: LikedExpandedDiscoveryTopEntry[] = [
    ...input.currentTop.map((row) => ({
      source: "CURRENT_POOL" as const,
      artistName: row.artistName,
      trackName: row.trackName,
      spotifyTrackId: row.spotifyTrackId,
      rankingScore: row.shadowRankingScore,
      displayScore: row.shadowScore,
      signalKind: row.signalKind,
      explanation: row.explanation,
    })),
    ...input.expansions.map((row) => ({
      source: "LIKED_EXPANSION" as const,
      artistName: row.artistName,
      trackName: row.trackName,
      spotifyTrackId: row.spotifyTrackId,
      rankingScore: row.scoreCard.score,
      displayScore: row.scoreCard.score,
      signalKind: "SIMILAR_EXPLORATORY" as const,
      explanation: expansionExplanation(row),
    })),
  ];
  const seenTracks = new Set<string>();
  return rows
    .sort((left, right) => {
      if (right.rankingScore !== left.rankingScore) {
        return right.rankingScore - left.rankingScore;
      }
      if (left.source !== right.source) return left.source === "CURRENT_POOL" ? -1 : 1;
      return `${left.artistName}\u0000${left.trackName}`.localeCompare(
        `${right.artistName}\u0000${right.trackName}`,
      );
    })
    .filter((row) => {
      const key = row.spotifyTrackId ?? `${normalized(row.artistName)}\u0000${normalized(row.trackName)}`;
      if (seenTracks.has(key)) return false;
      seenTracks.add(key);
      return true;
    })
    .slice(0, input.topN);
}

export function likedTrackCountAffinity(likedTrackCount: number): number {
  if (!Number.isInteger(likedTrackCount) || likedTrackCount < 1) {
    throw new Error("likedTrackCount must be a positive integer");
  }
  return Math.min(
    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.likedArtistAffinityMax,
    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.likedArtistAffinityBase +
      Math.log2(likedTrackCount) *
        LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.likedArtistAffinityPerDoubling,
  );
}

export function buildDiverseHistoryProbe(
  rows: LikedExpansionAggregate[],
  limit: number,
): LikedExpansionAggregate[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("history probe limit must be a positive integer");
  }
  const groups = new Map<string, LikedExpansionAggregate[]>();
  for (const row of rows) {
    const seedId = row.dominantSeed.spotifyArtistId;
    const group = groups.get(seedId) ?? [];
    group.push(row);
    groups.set(seedId, group);
  }
  const queues = [...groups.values()].map((group) => [...group]);
  const selected: LikedExpansionAggregate[] = [];
  while (selected.length < limit) {
    let progressed = false;
    for (const queue of queues) {
      const row = queue.shift();
      if (!row) continue;
      selected.push(row);
      progressed = true;
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }
  return selected;
}

export function buildLikedExpansionHistoryCounts(
  candidates: LikedExpansionAggregate[],
  historyRows: Array<{ artistName: string; artistMbid: string | null; count: number }>,
): Map<string, number> {
  const byName = new Map<string, number>();
  const byMbid = new Map<string, number>();
  for (const row of historyRows) {
    const name = normalized(row.artistName);
    byName.set(name, (byName.get(name) ?? 0) + row.count);
    if (row.artistMbid?.trim()) {
      const mbid = row.artistMbid.trim().toLowerCase();
      byMbid.set(mbid, (byMbid.get(mbid) ?? 0) + row.count);
    }
  }
  return new Map(
    candidates.map((candidate) => {
      const nameCount = byName.get(candidate.normalizedArtistName) ?? 0;
      const mbidCount = candidate.candidateArtistMbid
        ? byMbid.get(candidate.candidateArtistMbid.toLowerCase()) ?? 0
        : 0;
      return [candidate.normalizedArtistName, Math.max(nameCount, mbidCount)] as const;
    }),
  );
}

async function getArtistHistoryCounts(
  userId: string,
  candidates: LikedExpansionAggregate[],
): Promise<Map<string, number>> {
  if (candidates.length === 0) return new Map();
  const artistNames = [...new Set(candidates.map((row) => row.artistName))];
  const artistMbids = [
    ...new Set(
      candidates
        .map((row) => row.candidateArtistMbid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const orFilters = [
    { artistName: { in: artistNames, mode: "insensitive" as const } },
    ...(artistMbids.length > 0 ? [{ artistMbid: { in: artistMbids } }] : []),
  ];
  const rows = await prisma.trackListeningEvent.groupBy({
    by: ["artistName", "artistMbid"],
    where: { userId, OR: orFilters },
    _count: { _all: true },
  });
  return buildLikedExpansionHistoryCounts(
    candidates,
    rows.map((row) => ({
      artistName: row.artistName,
      artistMbid: row.artistMbid,
      count: row._count._all,
    })),
  );
}

export function materializeResolvedExpansionCandidate(
  candidate: LikedExpansionAggregate,
  resolution: SpotifyDiscoveryResolution,
): LikedExpansionResolvedCandidate {
  if (
    resolution.status !== "RESOLVED" ||
    !resolution.spotifyArtist ||
    !resolution.spotifyTrack
  ) {
    throw new Error("resolved Spotify artist and track are required");
  }
  const canonicalArtistName = resolution.spotifyArtist.name;
  return {
    ...candidate,
    providerArtistName: candidate.artistName,
    artistName: canonicalArtistName,
    normalizedArtistName: normalized(canonicalArtistName),
    scoreCard: {
      ...candidate.scoreCard,
      artistName: canonicalArtistName,
    },
    spotifyArtistId: resolution.spotifyArtist.id,
    spotifyTrackId: resolution.spotifyTrack.id,
    trackName: resolution.spotifyTrack.name,
    albumName: resolution.spotifyTrack.albumName,
    resolutionReason: resolution.reason,
  };
}

export function isResolvedDirectAffinityArtist(
  spotifyArtistId: string,
  directSpotifyArtistIds: ReadonlySet<string>,
): boolean {
  return directSpotifyArtistIds.has(spotifyArtistId);
}

export function isResolvedHistoricalArtist(
  spotifyArtistId: string,
  normalizedSpotifyArtistName: string,
  historicalSpotifyArtistIds: ReadonlySet<string>,
  historicalNormalizedArtistNames: ReadonlySet<string>,
): boolean {
  return (
    historicalSpotifyArtistIds.has(spotifyArtistId) ||
    hasEquivalentArtistName(
      historicalNormalizedArtistNames,
      normalizedSpotifyArtistName,
    )
  );
}

export function hasEquivalentArtistName(
  normalizedArtistNames: ReadonlySet<string>,
  normalizedArtistName: string,
): boolean {
  for (const form of controlledArtistIdentityForms(normalizedArtistName)) {
    if (normalizedArtistNames.has(form)) return true;
  }
  return false;
}

export function controlledArtistIdentityForms(value: string): string[] {
  const clean = normalized(value);
  if (!clean) return [];
  const forms = new Set<string>([clean]);
  if (/^the\s+/.test(clean)) {
    const alias = clean.replace(/^the\s+/, "").trim();
    if (alias.length >= 2) forms.add(alias);
  } else if (clean.length >= 2) {
    forms.add(`the ${clean}`);
  }
  return [...forms];
}

function betterSeed(
  candidate: LikedExpansionAggregate["dominantSeed"],
  current: LikedExpansionAggregate["dominantSeed"],
): boolean {
  const candidatePotential = 0.5 * candidate.similarity + 0.4 * candidate.affinity;
  const currentPotential = 0.5 * current.similarity + 0.4 * current.affinity;
  if (candidatePotential !== currentPotential) return candidatePotential > currentPotential;
  if (candidate.likedTrackCount !== current.likedTrackCount) {
    return candidate.likedTrackCount > current.likedTrackCount;
  }
  return candidate.artistName.localeCompare(current.artistName) < 0;
}

function compareExpansionRows(left: LikedExpansionAggregate, right: LikedExpansionAggregate): number {
  if (right.scoreCard.score !== left.scoreCard.score) {
    return right.scoreCard.score - left.scoreCard.score;
  }
  if (right.supportingSeeds !== left.supportingSeeds) {
    return right.supportingSeeds - left.supportingSeeds;
  }
  if (right.maxSimilarity !== left.maxSimilarity) {
    return right.maxSimilarity - left.maxSimilarity;
  }
  return left.artistName.localeCompare(right.artistName);
}

function expansionExplanation(row: LikedExpansionResolvedCandidate): string {
  const via = row.seedArtistNames.slice(0, 5).join(", ");
  return `Exploração LIKED: ${row.artistName} é relacionado a ${via}; similarity=${row.maxSimilarity.toFixed(3)}, seeds=${row.supportingSeeds}.`;
}

function entrants(
  expanded: LikedExpandedDiscoveryTopEntry[],
  comparison: Array<{ spotifyTrackId: string | null; artistName: string; trackName: string }>,
): LikedExpandedDiscoveryTopEntry[] {
  const keys = new Set(comparison.map(recommendationIdentity));
  return expanded.filter((row) => !keys.has(recommendationIdentity(row)));
}

function exits(
  expanded: LikedExpandedDiscoveryTopEntry[],
  comparison: LikedShadowRankedRecommendation[],
): LikedShadowRankedRecommendation[] {
  const keys = new Set(expanded.map(recommendationIdentity));
  return comparison.filter((row) => !keys.has(recommendationIdentity(row)));
}

function recommendationIdentity(row: {
  spotifyTrackId: string | null;
  artistName: string;
  trackName: string;
}): string {
  return row.spotifyTrackId ?? `${normalized(row.artistName)}\u0000${normalized(row.trackName)}`;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}
