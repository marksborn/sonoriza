import { ArtistSimilarityProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  getForYouReport,
  type ForYouRecommendation,
} from "@/services/music-discovery/for-you-report";
import {
  scoreExternalDiscoveryCandidate,
  type ExternalDiscoveryCandidateScore,
} from "@/services/music-discovery/scoring";
import { resolveExternalDiscoveryCandidate } from "@/services/music-discovery/spotify-resolution";
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

export type LikedExpansionAggregate = {
  candidateKey: string;
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

  const [directAffinities, activeSeeds, similarityEdges] = await Promise.all([
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
        sourceSpotifyArtistId: true,
        sourceArtistName: true,
        similarity: true,
      },
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
  const probes = ranked.rows.slice(
    0,
    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.historyProbeLimit,
  );
  const history = await getArtistHistoryCounts(
    userId,
    probes.map((row) => row.artistName),
  );
  const selection = selectLikedExpansionResolutionCandidates({
    rows: probes,
    historyByNormalizedArtistName: history,
    budget: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.resolutionCandidateBudget,
    maxPerDominantSeed: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.maxPerDominantSeed,
  });

  const spotify = await SpotifyCatalogSearchClient.forUser(userId);
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
      if (baselineTrackIds.has(resolution.spotifyTrack.id)) continue;
      if (seenTrackIds.has(resolution.spotifyTrack.id)) continue;
      seenTrackIds.add(resolution.spotifyTrack.id);
      resolvedCandidates.push({
        ...candidate,
        spotifyArtistId: resolution.spotifyArtist.id,
        spotifyTrackId: resolution.spotifyTrack.id,
        trackName: resolution.spotifyTrack.name,
        albumName: resolution.spotifyTrack.albumName,
        resolutionReason: resolution.reason,
      });
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
  similarityEdges: LikedSimilaritySignal[];
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
    input.directAffinities
      .filter((row) => row.active !== false)
      .map((row) => [row.spotifyArtistId, row] as const),
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
      artistName: edge.candidateArtistName,
      normalizedArtistName: key,
      maxSimilarity: 0,
      seedArtistNames: new Map<string, string>(),
      bestSeed: null,
    };
    current.candidateKeys.add(edge.candidateKey);
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
    if (aggregate.candidateKeys.size !== 1) {
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
      similarity: aggregate.maxSimilarity,
      seedArtistAffinity: aggregate.bestSeed.affinity,
      sourceConfidence: LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.sourceConfidence,
      knownHistoricalPlayCount: 0,
    });
    rows.push({
      candidateKey,
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
          similarity: row.maxSimilarity,
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

async function getArtistHistoryCounts(
  userId: string,
  artistNames: string[],
): Promise<Map<string, number>> {
  if (artistNames.length === 0) return new Map();
  const rows = await prisma.trackListeningEvent.groupBy({
    by: ["artistName"],
    where: {
      userId,
      artistName: { in: artistNames, mode: "insensitive" },
    },
    _count: { _all: true },
  });
  return new Map(
    rows
      .filter((row) => Boolean(row.artistName))
      .map((row) => [normalized(row.artistName ?? ""), row._count._all] as const),
  );
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
