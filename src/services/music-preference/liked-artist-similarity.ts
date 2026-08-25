import { ArtistSimilarityProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  LastFmSimilarityClient,
  type LastFmSimilarArtist,
} from "@/services/lastfm/similarity";

export const LIKED_ARTIST_SIMILARITY_POLICY = {
  sourceBudget: 25,
  maxSourceBudget: 200,
  perSeed: 10,
  maxPerSeed: 50,
  refreshDays: 30,
  failureCooldownHours: 6,
  providerDelayMs: 250,
} as const;

export type LikedArtistSimilarityMode = "PREVIEW" | "APPLY";

export type ActiveArtistAffinity = {
  spotifyArtistId: string;
  artistName: string | null;
  likedTrackCount: number;
  active: boolean;
};

export type ExistingArtistSimilaritySeed = {
  id: string;
  sourceSpotifyArtistId: string;
  sourceArtistName: string;
  active: boolean;
  lastFetchedAt: Date | null;
  refreshAfter: Date | null;
  candidateCount: number;
  lastError: string | null;
};

export type ExistingArtistSimilarityEdge = {
  id: string;
  seedStateId: string;
  sourceSpotifyArtistId: string;
  sourceArtistName: string;
  candidateKey: string;
  candidateArtistName: string;
  candidateArtistMbid: string | null;
  candidateArtistUrl: string | null;
  similarity: number;
  active: boolean;
};

export type SelectedSimilaritySeed = {
  spotifyArtistId: string;
  artistName: string;
  likedTrackCount: number;
  reason: "UNFETCHED" | "REACTIVATED" | "STALE";
};

export type ArtistSimilarityAcquisition = {
  source: SelectedSimilaritySeed;
  status: "SUCCESS" | "FAILURE";
  candidates: NormalizedSimilarArtist[];
  error: string | null;
};

export type NormalizedSimilarArtist = {
  candidateKey: string;
  name: string;
  mbid: string | null;
  url: string | null;
  similarity: number;
};

export type LikedArtistSimilarityPlan = {
  activeAffinityCount: number;
  sourcesWithoutName: number;
  freshSourceCount: number;
  staleSourceCount: number;
  unfetchedSourceCount: number;
  reactivatedSourceCount: number;
  selected: SelectedSimilaritySeed[];
  inactiveSeedIds: string[];
  inactiveSourceArtistIds: string[];
  seedMetadataUpdates: Array<{
    seedId: string;
    sourceSpotifyArtistId: string;
    sourceArtistName: string;
  }>;
  seedStatesToCreate: number;
  seedStatesToReactivate: number;
  seedStatesToRefresh: number;
  failedSeedUpdates: number;
  edgesToCreate: number;
  edgesToReactivate: number;
  edgesToUpdate: number;
  edgesToDeactivate: number;
  successfulSources: number;
  failedSources: number;
  rawCandidateRows: number;
  distinctCandidatesInBatch: number;
  directAffinityOverlapInBatch: number;
  topCandidates: Array<{
    candidateKey: string;
    artistName: string;
    maxSimilarity: number;
    supportingSeeds: number;
    directAffinity: boolean;
  }>;
  before: {
    activeSeeds: number;
    activeEdges: number;
    distinctCandidates: number;
  };
  after: {
    activeSeeds: number;
    activeEdges: number;
    distinctCandidates: number;
  };
};

export type LikedArtistSimilarityReport = {
  mode: LikedArtistSimilarityMode;
  provider: ArtistSimilarityProvider;
  generatedAt: Date;
  policy: {
    sourceBudget: number;
    perSeed: number;
    refreshDays: number;
    failureCooldownHours: number;
    providerDelayMs: number;
  };
  affinity: {
    activeArtists: number;
    withoutName: number;
  };
  cache: {
    freshSources: number;
    staleSources: number;
    unfetchedSources: number;
    reactivatedSources: number;
  };
  acquisition: {
    selectedSources: number;
    providerCalls: number;
    successfulSources: number;
    failedSources: number;
    rawCandidateRows: number;
    distinctCandidatesInBatch: number;
    directAffinityOverlapInBatch: number;
  };
  planned: {
    seedStatesToCreate: number;
    seedStatesToReactivate: number;
    seedStatesToRefresh: number;
    seedStatesToDeactivate: number;
    seedMetadataUpdates: number;
    failedSeedUpdates: number;
    edgesToCreate: number;
    edgesToReactivate: number;
    edgesToUpdate: number;
    edgesToDeactivate: number;
  };
  before: LikedArtistSimilarityPlan["before"];
  after: LikedArtistSimilarityPlan["after"];
  topCandidates: LikedArtistSimilarityPlan["topCandidates"];
  failures: Array<{
    sourceSpotifyArtistId: string;
    sourceArtistName: string;
    error: string;
  }>;
  plannerInfluence: false;
  spotifyWrites: false;
};

type SimilarityProvider = {
  getSimilarArtists(input: {
    artistName: string;
    artistMbid?: string | null;
    limit?: number;
  }): Promise<LastFmSimilarArtist[]>;
};

export function selectLikedArtistSimilaritySeeds(input: {
  affinities: ActiveArtistAffinity[];
  existingSeeds: ExistingArtistSimilaritySeed[];
  now: Date;
  budget: number;
}): {
  selected: SelectedSimilaritySeed[];
  activeAffinityCount: number;
  sourcesWithoutName: number;
  freshSourceCount: number;
  staleSourceCount: number;
  unfetchedSourceCount: number;
  reactivatedSourceCount: number;
} {
  assertPositiveInt(input.budget, "budget", LIKED_ARTIST_SIMILARITY_POLICY.maxSourceBudget);
  const stateBySource = new Map(
    input.existingSeeds.map((row) => [row.sourceSpotifyArtistId, row] as const),
  );
  const active = input.affinities.filter((row) => row.active);
  const candidates: SelectedSimilaritySeed[] = [];
  let sourcesWithoutName = 0;
  let freshSourceCount = 0;
  let staleSourceCount = 0;
  let unfetchedSourceCount = 0;
  let reactivatedSourceCount = 0;

  for (const affinity of active) {
    const artistName = affinity.artistName?.trim() || null;
    if (!artistName) {
      sourcesWithoutName += 1;
      continue;
    }
    const state = stateBySource.get(affinity.spotifyArtistId);
    if (!state) {
      unfetchedSourceCount += 1;
      candidates.push({
        spotifyArtistId: affinity.spotifyArtistId,
        artistName,
        likedTrackCount: affinity.likedTrackCount,
        reason: "UNFETCHED",
      });
      continue;
    }
    if (!state.active) {
      reactivatedSourceCount += 1;
      candidates.push({
        spotifyArtistId: affinity.spotifyArtistId,
        artistName,
        likedTrackCount: affinity.likedTrackCount,
        reason: "REACTIVATED",
      });
      continue;
    }
    if (!state.refreshAfter || state.refreshAfter.getTime() <= input.now.getTime()) {
      staleSourceCount += 1;
      candidates.push({
        spotifyArtistId: affinity.spotifyArtistId,
        artistName,
        likedTrackCount: affinity.likedTrackCount,
        reason: "STALE",
      });
    } else {
      freshSourceCount += 1;
    }
  }

  const priority: Record<SelectedSimilaritySeed["reason"], number> = {
    UNFETCHED: 0,
    REACTIVATED: 1,
    STALE: 2,
  };
  candidates.sort((left, right) => {
    const reason = priority[left.reason] - priority[right.reason];
    if (reason !== 0) return reason;
    if (left.likedTrackCount !== right.likedTrackCount) {
      return right.likedTrackCount - left.likedTrackCount;
    }
    return left.spotifyArtistId.localeCompare(right.spotifyArtistId);
  });

  return {
    selected: candidates.slice(0, input.budget),
    activeAffinityCount: active.length,
    sourcesWithoutName,
    freshSourceCount,
    staleSourceCount,
    unfetchedSourceCount,
    reactivatedSourceCount,
  };
}

export function normalizeLastFmSimilarArtists(
  sourceArtistName: string,
  rows: LastFmSimilarArtist[],
): NormalizedSimilarArtist[] {
  const sourceName = normalizedName(sourceArtistName);
  const byKey = new Map<string, NormalizedSimilarArtist>();
  for (const row of rows) {
    const name = row.name?.trim();
    if (!name || normalizedName(name) === sourceName) continue;
    if (!Number.isFinite(row.match) || row.match < 0 || row.match > 1) continue;
    const mbid = row.mbid?.trim() || null;
    const candidateKey = mbid
      ? `mbid:${mbid.toLocaleLowerCase("en-US")}`
      : `name:${normalizedName(name)}`;
    const candidate: NormalizedSimilarArtist = {
      candidateKey,
      name,
      mbid,
      url: row.url?.trim() || null,
      similarity: row.match,
    };
    const current = byKey.get(candidateKey);
    if (!current || candidate.similarity > current.similarity) {
      byKey.set(candidateKey, candidate);
    }
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.similarity !== right.similarity) return right.similarity - left.similarity;
    return left.candidateKey.localeCompare(right.candidateKey);
  });
}

export function buildLikedArtistSimilarityPlan(input: {
  affinities: ActiveArtistAffinity[];
  existingSeeds: ExistingArtistSimilaritySeed[];
  existingEdges: ExistingArtistSimilarityEdge[];
  acquisitions: ArtistSimilarityAcquisition[];
  now: Date;
  budget: number;
}): LikedArtistSimilarityPlan {
  const selection = selectLikedArtistSimilaritySeeds({
    affinities: input.affinities,
    existingSeeds: input.existingSeeds,
    now: input.now,
    budget: input.budget,
  });
  const activeAffinities = input.affinities.filter((row) => row.active);
  const activeAffinityIds = new Set(activeAffinities.map((row) => row.spotifyArtistId));
  const directAffinityNames = new Set(
    activeAffinities
      .map((row) => row.artistName?.trim())
      .filter((value): value is string => Boolean(value))
      .map(normalizedName),
  );
  const stateBySource = new Map(
    input.existingSeeds.map((row) => [row.sourceSpotifyArtistId, row] as const),
  );
  const existingEdgesBySource = groupEdgesBySource(input.existingEdges);

  const inactiveSeeds = input.existingSeeds.filter(
    (row) => row.active && !activeAffinityIds.has(row.sourceSpotifyArtistId),
  );
  const inactiveSourceArtistIds = inactiveSeeds.map((row) => row.sourceSpotifyArtistId);
  const seedMetadataUpdates = activeAffinities.flatMap((affinity) => {
    const name = affinity.artistName?.trim();
    const seed = stateBySource.get(affinity.spotifyArtistId);
    if (!name || !seed || seed.sourceArtistName === name) return [];
    return [{
      seedId: seed.id,
      sourceSpotifyArtistId: affinity.spotifyArtistId,
      sourceArtistName: name,
    }];
  });

  let seedStatesToCreate = 0;
  let seedStatesToReactivate = 0;
  let seedStatesToRefresh = 0;
  let failedSeedUpdates = 0;
  let edgesToCreate = 0;
  let edgesToReactivate = 0;
  let edgesToUpdate = 0;
  let edgesToDeactivate = input.existingEdges.filter(
    (row) => row.active && inactiveSourceArtistIds.includes(row.sourceSpotifyArtistId),
  ).length;

  const successful = input.acquisitions.filter((row) => row.status === "SUCCESS");
  const failed = input.acquisitions.filter((row) => row.status === "FAILURE");
  const batchCandidates = new Map<string, {
    artistName: string;
    maxSimilarity: number;
    sourceIds: Set<string>;
    directAffinity: boolean;
  }>();

  for (const acquisition of input.acquisitions) {
    const state = stateBySource.get(acquisition.source.spotifyArtistId);
    if (!state) seedStatesToCreate += 1;
    else if (!state.active) seedStatesToReactivate += 1;
    else if (acquisition.status === "SUCCESS") seedStatesToRefresh += 1;
    if (acquisition.status === "FAILURE") failedSeedUpdates += 1;

    if (acquisition.status !== "SUCCESS") continue;
    const existing = new Map(
      (existingEdgesBySource.get(acquisition.source.spotifyArtistId) ?? []).map(
        (row) => [row.candidateKey, row] as const,
      ),
    );
    const returnedKeys = new Set(acquisition.candidates.map((row) => row.candidateKey));
    for (const candidate of acquisition.candidates) {
      const row = existing.get(candidate.candidateKey);
      if (!row) edgesToCreate += 1;
      else if (!row.active) edgesToReactivate += 1;
      else if (edgeMetadataChanged(row, candidate, acquisition.source.artistName)) {
        edgesToUpdate += 1;
      }

      const aggregate = batchCandidates.get(candidate.candidateKey) ?? {
        artistName: candidate.name,
        maxSimilarity: candidate.similarity,
        sourceIds: new Set<string>(),
        directAffinity: directAffinityNames.has(normalizedName(candidate.name)),
      };
      aggregate.maxSimilarity = Math.max(aggregate.maxSimilarity, candidate.similarity);
      aggregate.sourceIds.add(acquisition.source.spotifyArtistId);
      aggregate.directAffinity ||= directAffinityNames.has(normalizedName(candidate.name));
      batchCandidates.set(candidate.candidateKey, aggregate);
    }
    edgesToDeactivate += [...existing.values()].filter(
      (row) => row.active && !returnedKeys.has(row.candidateKey),
    ).length;
  }

  const beforeActiveEdges = input.existingEdges.filter((row) => row.active);
  const projectedEdges = new Map<string, string>();
  for (const edge of beforeActiveEdges) {
    if (!activeAffinityIds.has(edge.sourceSpotifyArtistId)) continue;
    projectedEdges.set(
      `${edge.sourceSpotifyArtistId}\u0000${edge.candidateKey}`,
      edge.candidateKey,
    );
  }
  for (const acquisition of successful) {
    const prefix = `${acquisition.source.spotifyArtistId}\u0000`;
    for (const key of [...projectedEdges.keys()]) {
      if (key.startsWith(prefix)) projectedEdges.delete(key);
    }
    for (const candidate of acquisition.candidates) {
      projectedEdges.set(`${prefix}${candidate.candidateKey}`, candidate.candidateKey);
    }
  }

  const activeSeedSources = new Set(
    input.existingSeeds
      .filter((row) => row.active && activeAffinityIds.has(row.sourceSpotifyArtistId))
      .map((row) => row.sourceSpotifyArtistId),
  );
  for (const acquisition of input.acquisitions) {
    activeSeedSources.add(acquisition.source.spotifyArtistId);
  }

  const topCandidates = [...batchCandidates.entries()]
    .map(([candidateKey, row]) => ({
      candidateKey,
      artistName: row.artistName,
      maxSimilarity: row.maxSimilarity,
      supportingSeeds: row.sourceIds.size,
      directAffinity: row.directAffinity,
    }))
    .sort((left, right) => {
      if (left.maxSimilarity !== right.maxSimilarity) {
        return right.maxSimilarity - left.maxSimilarity;
      }
      if (left.supportingSeeds !== right.supportingSeeds) {
        return right.supportingSeeds - left.supportingSeeds;
      }
      return left.candidateKey.localeCompare(right.candidateKey);
    })
    .slice(0, 20);

  return {
    ...selection,
    inactiveSeedIds: inactiveSeeds.map((row) => row.id),
    inactiveSourceArtistIds,
    seedMetadataUpdates,
    seedStatesToCreate,
    seedStatesToReactivate,
    seedStatesToRefresh,
    failedSeedUpdates,
    edgesToCreate,
    edgesToReactivate,
    edgesToUpdate,
    edgesToDeactivate,
    successfulSources: successful.length,
    failedSources: failed.length,
    rawCandidateRows: successful.reduce((sum, row) => sum + row.candidates.length, 0),
    distinctCandidatesInBatch: batchCandidates.size,
    directAffinityOverlapInBatch: [...batchCandidates.values()].filter(
      (row) => row.directAffinity,
    ).length,
    topCandidates,
    before: {
      activeSeeds: input.existingSeeds.filter((row) => row.active).length,
      activeEdges: beforeActiveEdges.length,
      distinctCandidates: new Set(beforeActiveEdges.map((row) => row.candidateKey)).size,
    },
    after: {
      activeSeeds: activeSeedSources.size,
      activeEdges: projectedEdges.size,
      distinctCandidates: new Set(projectedEdges.values()).size,
    },
  };
}

export async function syncLikedArtistSimilarity(
  userId: string,
  options: {
    mode?: LikedArtistSimilarityMode;
    sourceBudget?: number;
    perSeed?: number;
    refreshDays?: number;
    failureCooldownHours?: number;
    providerDelayMs?: number;
    now?: Date;
    provider?: SimilarityProvider;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<LikedArtistSimilarityReport> {
  const mode = options.mode ?? "PREVIEW";
  const sourceBudget = options.sourceBudget ?? LIKED_ARTIST_SIMILARITY_POLICY.sourceBudget;
  const perSeed = options.perSeed ?? LIKED_ARTIST_SIMILARITY_POLICY.perSeed;
  const refreshDays = options.refreshDays ?? LIKED_ARTIST_SIMILARITY_POLICY.refreshDays;
  const failureCooldownHours =
    options.failureCooldownHours ?? LIKED_ARTIST_SIMILARITY_POLICY.failureCooldownHours;
  const providerDelayMs =
    options.providerDelayMs ?? LIKED_ARTIST_SIMILARITY_POLICY.providerDelayMs;
  const now = options.now ?? new Date();

  assertPositiveInt(sourceBudget, "sourceBudget", LIKED_ARTIST_SIMILARITY_POLICY.maxSourceBudget);
  assertPositiveInt(perSeed, "perSeed", LIKED_ARTIST_SIMILARITY_POLICY.maxPerSeed);
  assertPositiveInt(refreshDays, "refreshDays", 365);
  assertPositiveInt(failureCooldownHours, "failureCooldownHours", 168);
  if (!Number.isInteger(providerDelayMs) || providerDelayMs < 0 || providerDelayMs > 10_000) {
    throw new Error("providerDelayMs must be an integer between 0 and 10000");
  }

  const [affinities, existingSeeds, existingEdges] = await Promise.all([
    prisma.artistAffinityState.findMany({
      where: { userId },
      select: {
        spotifyArtistId: true,
        artistName: true,
        likedTrackCount: true,
        active: true,
      },
    }),
    prisma.artistSimilaritySeedState.findMany({
      where: { userId, provider: ArtistSimilarityProvider.LASTFM },
      select: {
        id: true,
        sourceSpotifyArtistId: true,
        sourceArtistName: true,
        active: true,
        lastFetchedAt: true,
        refreshAfter: true,
        candidateCount: true,
        lastError: true,
      },
    }),
    prisma.artistSimilarityEdge.findMany({
      where: { userId, provider: ArtistSimilarityProvider.LASTFM },
      select: {
        id: true,
        seedStateId: true,
        sourceSpotifyArtistId: true,
        sourceArtistName: true,
        candidateKey: true,
        candidateArtistName: true,
        candidateArtistMbid: true,
        candidateArtistUrl: true,
        similarity: true,
        active: true,
      },
    }),
  ]);

  const selection = selectLikedArtistSimilaritySeeds({
    affinities,
    existingSeeds,
    now,
    budget: sourceBudget,
  });
  const provider = options.provider ?? providerFromEnvironment();
  const sleep = options.sleep ?? delay;
  const acquisitions: ArtistSimilarityAcquisition[] = [];

  for (let index = 0; index < selection.selected.length; index += 1) {
    const source = selection.selected[index]!;
    if (index > 0 && providerDelayMs > 0) await sleep(providerDelayMs);
    try {
      const rows = await provider.getSimilarArtists({
        artistName: source.artistName,
        limit: perSeed,
      });
      acquisitions.push({
        source,
        status: "SUCCESS",
        candidates: normalizeLastFmSimilarArtists(source.artistName, rows),
        error: null,
      });
    } catch (error) {
      acquisitions.push({
        source,
        status: "FAILURE",
        candidates: [],
        error: errorMessage(error),
      });
    }
  }

  const plan = buildLikedArtistSimilarityPlan({
    affinities,
    existingSeeds,
    existingEdges,
    acquisitions,
    now,
    budget: sourceBudget,
  });

  if (mode === "APPLY") {
    await applyLikedArtistSimilarityPlan({
      userId,
      plan,
      acquisitions,
      now,
      refreshAfter: addDays(now, refreshDays),
      failureRefreshAfter: addHours(now, failureCooldownHours),
    });
  }

  return {
    mode,
    provider: ArtistSimilarityProvider.LASTFM,
    generatedAt: now,
    policy: {
      sourceBudget,
      perSeed,
      refreshDays,
      failureCooldownHours,
      providerDelayMs,
    },
    affinity: {
      activeArtists: plan.activeAffinityCount,
      withoutName: plan.sourcesWithoutName,
    },
    cache: {
      freshSources: plan.freshSourceCount,
      staleSources: plan.staleSourceCount,
      unfetchedSources: plan.unfetchedSourceCount,
      reactivatedSources: plan.reactivatedSourceCount,
    },
    acquisition: {
      selectedSources: plan.selected.length,
      providerCalls: acquisitions.length,
      successfulSources: plan.successfulSources,
      failedSources: plan.failedSources,
      rawCandidateRows: plan.rawCandidateRows,
      distinctCandidatesInBatch: plan.distinctCandidatesInBatch,
      directAffinityOverlapInBatch: plan.directAffinityOverlapInBatch,
    },
    planned: {
      seedStatesToCreate: plan.seedStatesToCreate,
      seedStatesToReactivate: plan.seedStatesToReactivate,
      seedStatesToRefresh: plan.seedStatesToRefresh,
      seedStatesToDeactivate: plan.inactiveSeedIds.length,
      seedMetadataUpdates: plan.seedMetadataUpdates.length,
      failedSeedUpdates: plan.failedSeedUpdates,
      edgesToCreate: plan.edgesToCreate,
      edgesToReactivate: plan.edgesToReactivate,
      edgesToUpdate: plan.edgesToUpdate,
      edgesToDeactivate: plan.edgesToDeactivate,
    },
    before: plan.before,
    after: plan.after,
    topCandidates: plan.topCandidates,
    failures: acquisitions.flatMap((row) =>
      row.status === "FAILURE"
        ? [{
            sourceSpotifyArtistId: row.source.spotifyArtistId,
            sourceArtistName: row.source.artistName,
            error: row.error ?? "Unknown provider error",
          }]
        : [],
    ),
    plannerInfluence: false,
    spotifyWrites: false,
  };
}

async function applyLikedArtistSimilarityPlan(input: {
  userId: string;
  plan: LikedArtistSimilarityPlan;
  acquisitions: ArtistSimilarityAcquisition[];
  now: Date;
  refreshAfter: Date;
  failureRefreshAfter: Date;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (input.plan.inactiveSourceArtistIds.length > 0) {
      await tx.artistSimilaritySeedState.updateMany({
        where: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: { in: input.plan.inactiveSourceArtistIds },
          active: true,
        },
        data: { active: false },
      });
      await tx.artistSimilarityEdge.updateMany({
        where: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: { in: input.plan.inactiveSourceArtistIds },
          active: true,
        },
        data: { active: false, removedAt: input.now },
      });
    }

    for (const metadata of input.plan.seedMetadataUpdates) {
      await tx.artistSimilaritySeedState.update({
        where: { id: metadata.seedId },
        data: { sourceArtistName: metadata.sourceArtistName },
      });
      await tx.artistSimilarityEdge.updateMany({
        where: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: metadata.sourceSpotifyArtistId,
        },
        data: { sourceArtistName: metadata.sourceArtistName },
      });
    }

    for (const acquisition of input.acquisitions) {
      const source = acquisition.source;
      const unique = {
        userId_provider_sourceSpotifyArtistId: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: source.spotifyArtistId,
        },
      } as const;

      if (acquisition.status === "FAILURE") {
        await tx.artistSimilaritySeedState.upsert({
          where: unique,
          create: {
            userId: input.userId,
            provider: ArtistSimilarityProvider.LASTFM,
            sourceSpotifyArtistId: source.spotifyArtistId,
            sourceArtistName: source.artistName,
            active: true,
            refreshAfter: input.failureRefreshAfter,
            candidateCount: 0,
            lastError: acquisition.error,
            lastErrorAt: input.now,
          },
          update: {
            sourceArtistName: source.artistName,
            active: true,
            refreshAfter: input.failureRefreshAfter,
            lastError: acquisition.error,
            lastErrorAt: input.now,
          },
        });
        continue;
      }

      const seed = await tx.artistSimilaritySeedState.upsert({
        where: unique,
        create: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: source.spotifyArtistId,
          sourceArtistName: source.artistName,
          active: true,
          lastFetchedAt: input.now,
          refreshAfter: input.refreshAfter,
          candidateCount: acquisition.candidates.length,
          lastError: null,
          lastErrorAt: null,
        },
        update: {
          sourceArtistName: source.artistName,
          active: true,
          lastFetchedAt: input.now,
          refreshAfter: input.refreshAfter,
          candidateCount: acquisition.candidates.length,
          lastError: null,
          lastErrorAt: null,
        },
        select: { id: true },
      });

      const returnedKeys = acquisition.candidates.map((row) => row.candidateKey);
      await tx.artistSimilarityEdge.updateMany({
        where: {
          userId: input.userId,
          provider: ArtistSimilarityProvider.LASTFM,
          sourceSpotifyArtistId: source.spotifyArtistId,
          active: true,
          ...(returnedKeys.length > 0
            ? { candidateKey: { notIn: returnedKeys } }
            : {}),
        },
        data: { active: false, removedAt: input.now },
      });

      for (const candidate of acquisition.candidates) {
        await tx.artistSimilarityEdge.upsert({
          where: {
            userId_provider_sourceSpotifyArtistId_candidateKey: {
              userId: input.userId,
              provider: ArtistSimilarityProvider.LASTFM,
              sourceSpotifyArtistId: source.spotifyArtistId,
              candidateKey: candidate.candidateKey,
            },
          },
          create: {
            userId: input.userId,
            seedStateId: seed.id,
            provider: ArtistSimilarityProvider.LASTFM,
            sourceSpotifyArtistId: source.spotifyArtistId,
            sourceArtistName: source.artistName,
            candidateKey: candidate.candidateKey,
            candidateArtistName: candidate.name,
            candidateArtistMbid: candidate.mbid,
            candidateArtistUrl: candidate.url,
            similarity: candidate.similarity,
            active: true,
            lastObservedAt: input.now,
          },
          update: {
            seedStateId: seed.id,
            sourceArtistName: source.artistName,
            candidateArtistName: candidate.name,
            candidateArtistMbid: candidate.mbid,
            candidateArtistUrl: candidate.url,
            similarity: candidate.similarity,
            active: true,
            lastObservedAt: input.now,
            removedAt: null,
          },
        });
      }
    }
  });
}

function providerFromEnvironment(): SimilarityProvider {
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("LASTFM_API_KEY is required for LIKED-01 Gate 3 similarity expansion");
  }
  return new LastFmSimilarityClient({ apiKey });
}

function groupEdgesBySource(
  edges: ExistingArtistSimilarityEdge[],
): Map<string, ExistingArtistSimilarityEdge[]> {
  const bySource = new Map<string, ExistingArtistSimilarityEdge[]>();
  for (const edge of edges) {
    const rows = bySource.get(edge.sourceSpotifyArtistId) ?? [];
    rows.push(edge);
    bySource.set(edge.sourceSpotifyArtistId, rows);
  }
  return bySource;
}

function edgeMetadataChanged(
  row: ExistingArtistSimilarityEdge,
  candidate: NormalizedSimilarArtist,
  sourceArtistName: string,
): boolean {
  return (
    row.sourceArtistName !== sourceArtistName ||
    row.candidateArtistName !== candidate.name ||
    row.candidateArtistMbid !== candidate.mbid ||
    row.candidateArtistUrl !== candidate.url ||
    Math.abs(row.similarity - candidate.similarity) > 1e-9
  );
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function assertPositiveInt(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
