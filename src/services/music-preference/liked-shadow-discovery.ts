import { ArtistSimilarityProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  getForYouReport,
  type ForYouCategory,
  type ForYouRecommendation,
  type ForYouReport,
} from "@/services/music-discovery/for-you-report";

export const LIKED_SHADOW_DISCOVERY_POLICY = {
  poolPerCategory: 12,
  topPerCategory: 4,
  directBoostBase: 6,
  directBoostPerDoubling: 2,
  directBoostMax: 12,
  similarBoostSimilarityWeight: 4,
  similarBoostSupportPerExtraSeed: 0.5,
  similarBoostSupportMax: 2,
  similarBoostMax: 6,
} as const;

export type LikedDirectAffinitySignal = {
  spotifyArtistId: string;
  artistName: string | null;
  likedTrackCount: number;
};

export type LikedSimilaritySignal = {
  candidateKey: string;
  candidateArtistName: string;
  sourceSpotifyArtistId: string;
  sourceArtistName: string;
  similarity: number;
};

export type LikedShadowSignalKind =
  | "DIRECT_LIKE"
  | "SIMILAR_EXPLORATORY"
  | "NONE";

export type LikedShadowRankedRecommendation = ForYouRecommendation & {
  baselineRank: number;
  shadowRank: number;
  baselineScore: number;
  shadowScore: number;
  boost: number;
  signalKind: LikedShadowSignalKind;
  explanation: string | null;
  directAffinity: {
    spotifyArtistId: string;
    likedTrackCount: number;
  } | null;
  similarAffinity: {
    maxSimilarity: number;
    supportingSeeds: number;
    seedArtistNames: string[];
  } | null;
};

export type LikedShadowDiversity = {
  slots: number;
  uniqueArtists: number;
  duplicateArtistSlots: number;
  maxSlotsFromOneArtist: number;
  directAffinitySlots: number;
  similarExploratorySlots: number;
  noSignalSlots: number;
};

export type LikedShadowCategoryComparison = {
  category: ForYouCategory;
  poolSize: number;
  baseline: LikedShadowRankedRecommendation[];
  shadow: LikedShadowRankedRecommendation[];
  changes: {
    overlapCount: number;
    jaccard: number;
    entrants: LikedShadowRankedRecommendation[];
    exits: LikedShadowRankedRecommendation[];
    moved: Array<{
      key: string;
      artistName: string;
      trackName: string;
      baselineRank: number;
      shadowRank: number;
      delta: number;
    }>;
    signalAffectedPool: number;
    signalAffectedTop: number;
  };
  diversity: {
    baseline: LikedShadowDiversity;
    shadow: LikedShadowDiversity;
  };
};

export type LikedShadowLatentArtist = {
  artistName: string;
  maxSimilarity: number;
  supportingSeeds: number;
  seedArtistNames: string[];
};

export type LikedShadowDiscoveryComparison = {
  generatedAt: Date;
  policy: typeof LIKED_SHADOW_DISCOVERY_POLICY & {
    identityBasis: "NORMALIZED_ARTIST_NAME_FAIL_CLOSED_ON_AMBIGUITY";
  };
  safety: {
    shadowOnly: true;
    databaseWrites: false;
    plannerInfluence: false;
    spotifyWrites: false;
    likedSignalProviderCalls: 0;
  };
  baseline: {
    generatedAt: Date;
    externalStatus: ForYouReport["external"];
    poolPerCategory: number;
    topPerCategory: number;
  };
  coverage: {
    activeDirectAffinityArtists: number;
    cachedSeedArtists: number;
    cachedSeedCoveragePct: number;
    activeSimilarityEdges: number;
    distinctCachedSimilarityCandidates: number;
    exploratoryCachedArtistNames: number;
    ambiguousDirectArtistNames: number;
    ambiguousSimilarityArtistNames: number;
  };
  categories: {
    familiar: LikedShadowCategoryComparison;
    rediscovery: LikedShadowCategoryComparison;
    discovery: LikedShadowCategoryComparison;
  };
  latentExploratoryArtists: {
    count: number;
    top: LikedShadowLatentArtist[];
    note: string;
  };
};

export type LikedShadowDiscoveryOptions = {
  poolPerCategory?: number;
  topPerCategory?: number;
};

type DirectAffinityIndex = {
  byName: Map<string, LikedDirectAffinitySignal>;
  allNames: Set<string>;
  ambiguousNames: Set<string>;
};

type SimilarityAggregate = {
  artistName: string;
  maxSimilarity: number;
  sourceIds: Set<string>;
  sourceNames: Map<string, string>;
  candidateKeys: Set<string>;
};

type SimilarityIndex = {
  byName: Map<string, SimilarityAggregate>;
  ambiguousNames: Set<string>;
};

type EnrichedRecommendation = {
  recommendation: ForYouRecommendation;
  baselineRank: number;
  shadowScore: number;
  boost: number;
  signalKind: LikedShadowSignalKind;
  explanation: string | null;
  directAffinity: LikedShadowRankedRecommendation["directAffinity"];
  similarAffinity: LikedShadowRankedRecommendation["similarAffinity"];
};

export async function getLikedShadowDiscoveryComparison(
  userId: string,
  options: LikedShadowDiscoveryOptions = {},
): Promise<LikedShadowDiscoveryComparison> {
  const poolPerCategory = boundedPositiveInt(
    options.poolPerCategory ?? LIKED_SHADOW_DISCOVERY_POLICY.poolPerCategory,
    "poolPerCategory",
    12,
  );
  const topPerCategory = boundedPositiveInt(
    options.topPerCategory ?? LIKED_SHADOW_DISCOVERY_POLICY.topPerCategory,
    "topPerCategory",
    poolPerCategory,
  );

  // Keep the heavy DISCOVERY profile calculation isolated. LIKED state is loaded
  // only after the compact For You report exists, avoiding the old high-RSS pattern
  // of materializing independent large universes in parallel.
  const baseline = await getForYouReport(userId, { limitPerCategory: poolPerCategory });

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

  return buildLikedShadowDiscoveryComparison({
    baseline,
    directAffinities,
    similarityEdges,
    activeSeedCount: new Set(activeSeeds.map((row) => row.sourceSpotifyArtistId)).size,
    poolPerCategory,
    topPerCategory,
  });
}

export function buildLikedShadowDiscoveryComparison(input: {
  baseline: ForYouReport;
  directAffinities: LikedDirectAffinitySignal[];
  similarityEdges: LikedSimilaritySignal[];
  activeSeedCount: number;
  poolPerCategory: number;
  topPerCategory: number;
}): LikedShadowDiscoveryComparison {
  const poolPerCategory = boundedPositiveInt(input.poolPerCategory, "poolPerCategory", 12);
  const topPerCategory = boundedPositiveInt(
    input.topPerCategory,
    "topPerCategory",
    poolPerCategory,
  );
  if (!Number.isInteger(input.activeSeedCount) || input.activeSeedCount < 0) {
    throw new Error("activeSeedCount must be a non-negative integer");
  }

  const directIndex = buildDirectAffinityIndex(input.directAffinities);
  const similarityIndex = buildSimilarityIndex(input.similarityEdges);

  const familiar = buildCategoryComparison(
    "FAMILIAR",
    input.baseline.familiar.slice(0, poolPerCategory),
    directIndex,
    similarityIndex,
    topPerCategory,
  );
  const rediscovery = buildCategoryComparison(
    "REDESCOBERTA",
    input.baseline.rediscovery.slice(0, poolPerCategory),
    directIndex,
    similarityIndex,
    topPerCategory,
  );
  const discoveryPool = input.baseline.discovery.slice(0, poolPerCategory);
  const discovery = buildCategoryComparison(
    "DESCOBERTA",
    discoveryPool,
    directIndex,
    similarityIndex,
    topPerCategory,
  );

  const latent = buildLatentExploratoryArtists({
    similarityIndex,
    directNames: directIndex.allNames,
    representedDiscoveryNames: new Set(
      discoveryPool.map((row) => normalizedName(row.artistName)),
    ),
  });
  const distinctCachedSimilarityCandidates = new Set(
    input.similarityEdges.map((row) => row.candidateKey),
  ).size;
  const exploratoryCachedArtistNames = [...similarityIndex.byName.keys()].filter(
    (name) => !directIndex.allNames.has(name) && !similarityIndex.ambiguousNames.has(name),
  ).length;

  return {
    generatedAt: new Date(),
    policy: {
      ...LIKED_SHADOW_DISCOVERY_POLICY,
      poolPerCategory,
      topPerCategory,
      identityBasis: "NORMALIZED_ARTIST_NAME_FAIL_CLOSED_ON_AMBIGUITY",
    },
    safety: {
      shadowOnly: true,
      databaseWrites: false,
      plannerInfluence: false,
      spotifyWrites: false,
      likedSignalProviderCalls: 0,
    },
    baseline: {
      generatedAt: new Date(input.baseline.generatedAt),
      externalStatus: input.baseline.external,
      poolPerCategory,
      topPerCategory,
    },
    coverage: {
      activeDirectAffinityArtists: input.directAffinities.length,
      cachedSeedArtists: input.activeSeedCount,
      cachedSeedCoveragePct:
        input.directAffinities.length === 0
          ? 0
          : rounded((input.activeSeedCount / input.directAffinities.length) * 100, 2),
      activeSimilarityEdges: input.similarityEdges.length,
      distinctCachedSimilarityCandidates,
      exploratoryCachedArtistNames,
      ambiguousDirectArtistNames: directIndex.ambiguousNames.size,
      ambiguousSimilarityArtistNames: similarityIndex.ambiguousNames.size,
    },
    categories: { familiar, rediscovery, discovery },
    latentExploratoryArtists: {
      count: latent.length,
      top: latent.slice(0, 12),
      note:
        "Artistas relacionados já presentes no cache LIKED-01, mas sem faixa no pool atual de Para você. Gate 4 não inventa/resvolve faixas para eles.",
    },
  };
}

function buildCategoryComparison(
  category: ForYouCategory,
  rows: ForYouRecommendation[],
  directIndex: DirectAffinityIndex,
  similarityIndex: SimilarityIndex,
  topN: number,
): LikedShadowCategoryComparison {
  const enriched = rows.map((recommendation, index) =>
    enrichRecommendation(
      recommendation,
      index + 1,
      category,
      directIndex,
      similarityIndex,
    ),
  );
  const rankedShadow = [...enriched].sort((left, right) => {
    if (left.shadowScore !== right.shadowScore) return right.shadowScore - left.shadowScore;
    if (left.recommendation.score !== right.recommendation.score) {
      return right.recommendation.score - left.recommendation.score;
    }
    if (left.baselineRank !== right.baselineRank) return left.baselineRank - right.baselineRank;
    return left.recommendation.key.localeCompare(right.recommendation.key);
  });
  const shadowRankByKey = new Map(
    rankedShadow.map((row, index) => [row.recommendation.key, index + 1] as const),
  );
  const baselineTop = enriched
    .slice(0, topN)
    .map((row) => materializeRanked(row, shadowRankByKey.get(row.recommendation.key)!));
  const shadowTop = rankedShadow
    .slice(0, topN)
    .map((row, index) => materializeRanked(row, index + 1));

  const baselineKeys = new Set(baselineTop.map((row) => row.key));
  const shadowKeys = new Set(shadowTop.map((row) => row.key));
  const overlapCount = [...baselineKeys].filter((key) => shadowKeys.has(key)).length;
  const unionCount = new Set([...baselineKeys, ...shadowKeys]).size;

  const entrants = shadowTop.filter((row) => !baselineKeys.has(row.key));
  const exits = baselineTop.filter((row) => !shadowKeys.has(row.key));
  const moved = shadowTop
    .filter((row) => baselineKeys.has(row.key) && row.baselineRank !== row.shadowRank)
    .map((row) => ({
      key: row.key,
      artistName: row.artistName,
      trackName: row.trackName,
      baselineRank: row.baselineRank,
      shadowRank: row.shadowRank,
      delta: row.baselineRank - row.shadowRank,
    }));

  return {
    category,
    poolSize: rows.length,
    baseline: baselineTop,
    shadow: shadowTop,
    changes: {
      overlapCount,
      jaccard: unionCount === 0 ? 1 : rounded(overlapCount / unionCount, 3),
      entrants,
      exits,
      moved,
      signalAffectedPool: enriched.filter((row) => row.signalKind !== "NONE").length,
      signalAffectedTop: shadowTop.filter((row) => row.signalKind !== "NONE").length,
    },
    diversity: {
      baseline: diversityOf(baselineTop),
      shadow: diversityOf(shadowTop),
    },
  };
}

function enrichRecommendation(
  recommendation: ForYouRecommendation,
  baselineRank: number,
  category: ForYouCategory,
  directIndex: DirectAffinityIndex,
  similarityIndex: SimilarityIndex,
): EnrichedRecommendation {
  const nameKey = normalizedName(recommendation.artistName);
  const directKnownByName = directIndex.allNames.has(nameKey);
  const direct = directIndex.byName.get(nameKey) ?? null;
  const similar = similarityIndex.byName.get(nameKey) ?? null;
  const similarUsable = similar && !similarityIndex.ambiguousNames.has(nameKey) ? similar : null;

  let boost = 0;
  let signalKind: LikedShadowSignalKind = "NONE";
  let explanation: string | null = null;

  if (direct) {
    boost = directAffinityBoost(direct.likedTrackCount);
    signalKind = "DIRECT_LIKE";
    explanation = `LIKE direto: ${direct.likedTrackCount} faixa(s) curtida(s) de ${recommendation.artistName}.`;
  } else if (!directKnownByName && category === "DESCOBERTA" && similarUsable) {
    boost = similarityAffinityBoost(
      similarUsable.maxSimilarity,
      similarUsable.sourceIds.size,
    );
    signalKind = "SIMILAR_EXPLORATORY";
    const seeds = orderedSeedNames(similarUsable).slice(0, 3);
    explanation = `Exploração relacionada a ${seeds.join(", ")}; similaridade máxima ${similarUsable.maxSimilarity.toFixed(2)} em ${similarUsable.sourceIds.size} semente(s).`;
  }

  return {
    recommendation,
    baselineRank,
    shadowScore: rounded(Math.min(100, recommendation.score + boost), 3),
    boost,
    signalKind,
    explanation,
    directAffinity: direct
      ? {
          spotifyArtistId: direct.spotifyArtistId,
          likedTrackCount: direct.likedTrackCount,
        }
      : null,
    similarAffinity: similarUsable
      ? {
          maxSimilarity: rounded(similarUsable.maxSimilarity, 3),
          supportingSeeds: similarUsable.sourceIds.size,
          seedArtistNames: orderedSeedNames(similarUsable).slice(0, 5),
        }
      : null,
  };
}

function materializeRanked(
  row: EnrichedRecommendation,
  shadowRank: number,
): LikedShadowRankedRecommendation {
  return {
    ...row.recommendation,
    baselineRank: row.baselineRank,
    shadowRank,
    baselineScore: row.recommendation.score,
    shadowScore: row.shadowScore,
    boost: row.boost,
    signalKind: row.signalKind,
    explanation: row.explanation,
    directAffinity: row.directAffinity,
    similarAffinity: row.similarAffinity,
  };
}

export function directAffinityBoost(likedTrackCount: number): number {
  if (!Number.isInteger(likedTrackCount) || likedTrackCount < 1) {
    throw new Error("likedTrackCount must be a positive integer");
  }
  return rounded(
    Math.min(
      LIKED_SHADOW_DISCOVERY_POLICY.directBoostMax,
      LIKED_SHADOW_DISCOVERY_POLICY.directBoostBase +
        Math.log2(likedTrackCount) *
          LIKED_SHADOW_DISCOVERY_POLICY.directBoostPerDoubling,
    ),
    3,
  );
}

export function similarityAffinityBoost(
  maxSimilarity: number,
  supportingSeeds: number,
): number {
  if (!Number.isFinite(maxSimilarity) || maxSimilarity < 0 || maxSimilarity > 1) {
    throw new Error("maxSimilarity must be between 0 and 1");
  }
  if (!Number.isInteger(supportingSeeds) || supportingSeeds < 1) {
    throw new Error("supportingSeeds must be a positive integer");
  }
  const supportBonus = Math.min(
    LIKED_SHADOW_DISCOVERY_POLICY.similarBoostSupportMax,
    Math.max(0, supportingSeeds - 1) *
      LIKED_SHADOW_DISCOVERY_POLICY.similarBoostSupportPerExtraSeed,
  );
  return rounded(
    Math.min(
      LIKED_SHADOW_DISCOVERY_POLICY.similarBoostMax,
      maxSimilarity * LIKED_SHADOW_DISCOVERY_POLICY.similarBoostSimilarityWeight +
        supportBonus,
    ),
    3,
  );
}

function buildDirectAffinityIndex(rows: LikedDirectAffinitySignal[]): DirectAffinityIndex {
  const groups = new Map<string, LikedDirectAffinitySignal[]>();
  for (const row of rows) {
    const artistName = row.artistName?.trim();
    if (!artistName || !Number.isInteger(row.likedTrackCount) || row.likedTrackCount < 1) {
      continue;
    }
    const key = normalizedName(artistName);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const byName = new Map<string, LikedDirectAffinitySignal>();
  const ambiguousNames = new Set<string>();
  for (const [key, group] of groups) {
    const artistIds = new Set(group.map((row) => row.spotifyArtistId));
    if (artistIds.size !== 1) {
      ambiguousNames.add(key);
      continue;
    }
    byName.set(
      key,
      group.reduce((best, row) =>
        row.likedTrackCount > best.likedTrackCount ? row : best,
      ),
    );
  }
  return { byName, allNames: new Set(groups.keys()), ambiguousNames };
}

function buildSimilarityIndex(rows: LikedSimilaritySignal[]): SimilarityIndex {
  const byName = new Map<string, SimilarityAggregate>();
  for (const row of rows) {
    const artistName = row.candidateArtistName.trim();
    const sourceName = row.sourceArtistName.trim();
    if (
      !artistName ||
      !sourceName ||
      !Number.isFinite(row.similarity) ||
      row.similarity < 0 ||
      row.similarity > 1
    ) {
      continue;
    }
    const key = normalizedName(artistName);
    const aggregate = byName.get(key) ?? {
      artistName,
      maxSimilarity: row.similarity,
      sourceIds: new Set<string>(),
      sourceNames: new Map<string, string>(),
      candidateKeys: new Set<string>(),
    };
    aggregate.maxSimilarity = Math.max(aggregate.maxSimilarity, row.similarity);
    aggregate.sourceIds.add(row.sourceSpotifyArtistId);
    aggregate.sourceNames.set(row.sourceSpotifyArtistId, sourceName);
    aggregate.candidateKeys.add(row.candidateKey);
    byName.set(key, aggregate);
  }

  const ambiguousNames = new Set<string>();
  for (const [key, aggregate] of byName) {
    if (aggregate.candidateKeys.size > 1) ambiguousNames.add(key);
  }
  return { byName, ambiguousNames };
}

function buildLatentExploratoryArtists(input: {
  similarityIndex: SimilarityIndex;
  directNames: Set<string>;
  representedDiscoveryNames: Set<string>;
}): LikedShadowLatentArtist[] {
  return [...input.similarityIndex.byName.entries()]
    .filter(
      ([name]) =>
        !input.directNames.has(name) &&
        !input.representedDiscoveryNames.has(name) &&
        !input.similarityIndex.ambiguousNames.has(name),
    )
    .map(([, row]) => ({
      artistName: row.artistName,
      maxSimilarity: rounded(row.maxSimilarity, 3),
      supportingSeeds: row.sourceIds.size,
      seedArtistNames: orderedSeedNames(row).slice(0, 5),
    }))
    .sort((left, right) => {
      if (left.maxSimilarity !== right.maxSimilarity) {
        return right.maxSimilarity - left.maxSimilarity;
      }
      if (left.supportingSeeds !== right.supportingSeeds) {
        return right.supportingSeeds - left.supportingSeeds;
      }
      return normalizedName(left.artistName).localeCompare(normalizedName(right.artistName));
    });
}

function diversityOf(rows: LikedShadowRankedRecommendation[]): LikedShadowDiversity {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = normalizedName(row.artistName);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    slots: rows.length,
    uniqueArtists: counts.size,
    duplicateArtistSlots: Math.max(0, rows.length - counts.size),
    maxSlotsFromOneArtist: counts.size === 0 ? 0 : Math.max(...counts.values()),
    directAffinitySlots: rows.filter((row) => row.signalKind === "DIRECT_LIKE").length,
    similarExploratorySlots: rows.filter(
      (row) => row.signalKind === "SIMILAR_EXPLORATORY",
    ).length,
    noSignalSlots: rows.filter((row) => row.signalKind === "NONE").length,
  };
}

function orderedSeedNames(row: SimilarityAggregate): string[] {
  return [...row.sourceNames.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([, name]) => name);
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function boundedPositiveInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function rounded(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
