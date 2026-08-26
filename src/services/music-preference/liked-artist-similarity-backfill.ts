import { ArtistSimilarityProvider } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  LIKED_ARTIST_SIMILARITY_POLICY,
  syncLikedArtistSimilarity,
} from "@/services/music-preference/liked-artist-similarity";

export const LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY = {
  batchBudget: 100,
  maxBatchBudget: LIKED_ARTIST_SIMILARITY_POLICY.maxSourceBudget,
  maxBatches: 10,
  hardMaxBatches: 20,
  perSeed: LIKED_ARTIST_SIMILARITY_POLICY.perSeed,
  providerDelayMs: LIKED_ARTIST_SIMILARITY_POLICY.providerDelayMs,
  batchPauseMs: 1_000,
  maxBatchPauseMs: 60_000,
  providerFailureGuardRate: 0.2,
  providerFailureGuardMinFailures: 3,
} as const;

export type LikedArtistSimilarityBackfillMode = "PREVIEW" | "APPLY";

export type LikedArtistSimilarityBackfillStatus =
  | "READY"
  | "COMPLETE"
  | "PARTIAL_MAX_BATCHES"
  | "BLOCKED_COOLDOWN"
  | "PROVIDER_FAILURE_GUARD"
  | "STALE_REFRESH_INTERFERENCE_GUARD"
  | "NO_PROGRESS";

export type BackfillAffinityRow = {
  spotifyArtistId: string;
  artistName: string | null;
  active: boolean;
};

export type BackfillSeedRow = {
  sourceSpotifyArtistId: string;
  active: boolean;
  lastFetchedAt: Date | null;
  refreshAfter: Date | null;
  lastError: string | null;
};

export type BackfillEdgeRow = {
  sourceSpotifyArtistId: string;
  candidateKey: string;
  active: boolean;
};

export type LikedArtistSimilarityBackfillSnapshot = {
  generatedAt: Date;
  activeAffinityArtists: number;
  queryableAffinityArtists: number;
  withoutArtistName: number;
  successfulActiveSeeds: number;
  pendingSources: number;
  priorityReadySources: number;
  retryableFailedSources: number;
  cooldownBlockedSources: number;
  staleSuccessfulSources: number;
  coveragePct: number;
  activeSeedRows: number;
  activeSimilarityEdges: number;
  distinctCandidates: number;
  duplicateActiveSeedRows: number;
  duplicateActiveEdgeRows: number;
  priorityReadySourceIds: string[];
  retryableFailedSourceIds: string[];
};

export type LikedArtistSimilarityBackfillPlan = {
  pendingSources: number;
  readySourcesNow: number;
  blockedByCooldown: number;
  estimatedBatchesThisRun: number;
  estimatedProviderCallsThisRun: number;
  maxProviderCallsThisRun: number;
  canCompleteThisRun: boolean;
};

export type LikedArtistSimilarityBackfillBatch = {
  batch: number;
  requestedBudget: number;
  selectedSources: number;
  providerCalls: number;
  successfulSources: number;
  failedSources: number;
  failureRate: number;
  beforeActiveSeeds: number;
  afterActiveSeeds: number;
  beforeActiveEdges: number;
  afterActiveEdges: number;
  failures: Array<{
    sourceSpotifyArtistId: string;
    sourceArtistName: string;
    error: string;
  }>;
};

export type LikedArtistSimilarityBackfillReport = {
  mode: LikedArtistSimilarityBackfillMode;
  status: LikedArtistSimilarityBackfillStatus;
  generatedAt: Date;
  policy: {
    batchBudget: number;
    maxBatches: number;
    perSeed: number;
    providerDelayMs: number;
    batchPauseMs: number;
    providerFailureGuardRate: number;
    providerFailureGuardMinFailures: number;
  };
  before: LikedArtistSimilarityBackfillSnapshot;
  plan: LikedArtistSimilarityBackfillPlan;
  batches: LikedArtistSimilarityBackfillBatch[];
  after: LikedArtistSimilarityBackfillSnapshot;
  totals: {
    providerCalls: number;
    successfulSources: number;
    failedSources: number;
  };
  safety: {
    shadowOnly: true;
    plannerInfluence: false;
    spotifyWrites: false;
    previewProviderCalls: 0;
    databaseWrites: boolean;
  };
};

type BatchExecutionOptions = {
  sourceBudget: number;
  perSeed: number;
  providerDelayMs: number;
};

type BatchExecutionResult = Omit<LikedArtistSimilarityBackfillBatch, "batch" | "requestedBudget" | "failureRate">;

type BackfillDependencies = {
  loadSnapshot: (userId: string, now: Date) => Promise<LikedArtistSimilarityBackfillSnapshot>;
  executeBatch: (userId: string, options: BatchExecutionOptions) => Promise<BatchExecutionResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
};

export function buildLikedArtistSimilarityBackfillSnapshot(input: {
  affinities: BackfillAffinityRow[];
  seeds: BackfillSeedRow[];
  edges: BackfillEdgeRow[];
  now: Date;
}): LikedArtistSimilarityBackfillSnapshot {
  const activeAffinities = input.affinities.filter((row) => row.active);
  const queryableAffinities = activeAffinities.filter((row) => Boolean(row.artistName?.trim()));
  const seedBySource = new Map<string, BackfillSeedRow>();
  for (const seed of input.seeds) {
    if (!seedBySource.has(seed.sourceSpotifyArtistId)) {
      seedBySource.set(seed.sourceSpotifyArtistId, seed);
    }
  }

  const successfulSourceIds = new Set<string>();
  const priorityReadySourceIds: string[] = [];
  const retryableFailedSourceIds: string[] = [];
  let cooldownBlockedSources = 0;
  let staleSuccessfulSources = 0;

  for (const affinity of queryableAffinities) {
    const seed = seedBySource.get(affinity.spotifyArtistId);
    if (!seed || !seed.active) {
      priorityReadySourceIds.push(affinity.spotifyArtistId);
      continue;
    }

    if (seed.lastFetchedAt) {
      successfulSourceIds.add(affinity.spotifyArtistId);
      if (!seed.refreshAfter || seed.refreshAfter.getTime() <= input.now.getTime()) {
        staleSuccessfulSources += 1;
      }
      continue;
    }

    if (seed.refreshAfter && seed.refreshAfter.getTime() > input.now.getTime()) {
      cooldownBlockedSources += 1;
      continue;
    }

    retryableFailedSourceIds.push(affinity.spotifyArtistId);
  }

  priorityReadySourceIds.sort();
  retryableFailedSourceIds.sort();

  const activeSeeds = input.seeds.filter((row) => row.active);
  const activeEdges = input.edges.filter((row) => row.active);
  const activeSeedKeys = new Set(activeSeeds.map((row) => row.sourceSpotifyArtistId));
  const activeEdgeKeys = new Set(
    activeEdges.map((row) => `${row.sourceSpotifyArtistId}\u0000${row.candidateKey}`),
  );
  const distinctCandidates = new Set(activeEdges.map((row) => row.candidateKey));
  const queryableAffinityArtists = queryableAffinities.length;
  const successfulActiveSeeds = successfulSourceIds.size;
  const pendingSources = Math.max(0, queryableAffinityArtists - successfulActiveSeeds);

  return {
    generatedAt: input.now,
    activeAffinityArtists: activeAffinities.length,
    queryableAffinityArtists,
    withoutArtistName: activeAffinities.length - queryableAffinityArtists,
    successfulActiveSeeds,
    pendingSources,
    priorityReadySources: priorityReadySourceIds.length,
    retryableFailedSources: retryableFailedSourceIds.length,
    cooldownBlockedSources,
    staleSuccessfulSources,
    coveragePct:
      queryableAffinityArtists === 0
        ? 100
        : rounded((successfulActiveSeeds / queryableAffinityArtists) * 100, 2),
    activeSeedRows: activeSeeds.length,
    activeSimilarityEdges: activeEdges.length,
    distinctCandidates: distinctCandidates.size,
    duplicateActiveSeedRows: Math.max(0, activeSeeds.length - activeSeedKeys.size),
    duplicateActiveEdgeRows: Math.max(0, activeEdges.length - activeEdgeKeys.size),
    priorityReadySourceIds,
    retryableFailedSourceIds,
  };
}

export function buildLikedArtistSimilarityBackfillPlan(
  snapshot: LikedArtistSimilarityBackfillSnapshot,
  options: { batchBudget: number; maxBatches: number },
): LikedArtistSimilarityBackfillPlan {
  assertPositiveInt(
    options.batchBudget,
    "batchBudget",
    LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.maxBatchBudget,
  );
  assertPositiveInt(
    options.maxBatches,
    "maxBatches",
    LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.hardMaxBatches,
  );

  const retryableWithoutStaleInterference =
    snapshot.staleSuccessfulSources === 0 ? snapshot.retryableFailedSources : 0;
  const readySourcesNow = snapshot.priorityReadySources + retryableWithoutStaleInterference;
  const maxProviderCallsThisRun = options.batchBudget * options.maxBatches;
  const estimatedProviderCallsThisRun = Math.min(readySourcesNow, maxProviderCallsThisRun);
  const estimatedBatchesThisRun =
    estimatedProviderCallsThisRun === 0
      ? 0
      : Math.ceil(estimatedProviderCallsThisRun / options.batchBudget);

  return {
    pendingSources: snapshot.pendingSources,
    readySourcesNow,
    blockedByCooldown: snapshot.cooldownBlockedSources,
    estimatedBatchesThisRun,
    estimatedProviderCallsThisRun,
    maxProviderCallsThisRun,
    canCompleteThisRun:
      snapshot.pendingSources === 0 ||
      (snapshot.cooldownBlockedSources === 0 &&
        snapshot.retryableFailedSources === retryableWithoutStaleInterference &&
        estimatedProviderCallsThisRun >= snapshot.pendingSources),
  };
}

export async function loadLikedArtistSimilarityBackfillSnapshot(
  userId: string,
  now: Date = new Date(),
): Promise<LikedArtistSimilarityBackfillSnapshot> {
  const [affinities, seeds, edges] = await Promise.all([
    prisma.artistAffinityState.findMany({
      where: { userId },
      select: {
        spotifyArtistId: true,
        artistName: true,
        active: true,
      },
    }),
    prisma.artistSimilaritySeedState.findMany({
      where: { userId, provider: ArtistSimilarityProvider.LASTFM },
      select: {
        sourceSpotifyArtistId: true,
        active: true,
        lastFetchedAt: true,
        refreshAfter: true,
        lastError: true,
      },
    }),
    prisma.artistSimilarityEdge.findMany({
      where: { userId, provider: ArtistSimilarityProvider.LASTFM, active: true },
      select: {
        sourceSpotifyArtistId: true,
        candidateKey: true,
        active: true,
      },
    }),
  ]);

  return buildLikedArtistSimilarityBackfillSnapshot({ affinities, seeds, edges, now });
}

export async function runLikedArtistSimilarityBackfill(
  userId: string,
  options: {
    mode?: LikedArtistSimilarityBackfillMode;
    batchBudget?: number;
    maxBatches?: number;
    perSeed?: number;
    providerDelayMs?: number;
    batchPauseMs?: number;
  } = {},
  dependencies: Partial<BackfillDependencies> = {},
): Promise<LikedArtistSimilarityBackfillReport> {
  const mode = options.mode ?? "PREVIEW";
  const batchBudget =
    options.batchBudget ?? LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.batchBudget;
  const maxBatches = options.maxBatches ?? LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.maxBatches;
  const perSeed = options.perSeed ?? LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.perSeed;
  const providerDelayMs =
    options.providerDelayMs ?? LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerDelayMs;
  const batchPauseMs =
    options.batchPauseMs ?? LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.batchPauseMs;

  assertPositiveInt(
    batchBudget,
    "batchBudget",
    LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.maxBatchBudget,
  );
  assertPositiveInt(
    maxBatches,
    "maxBatches",
    LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.hardMaxBatches,
  );
  assertPositiveInt(perSeed, "perSeed", LIKED_ARTIST_SIMILARITY_POLICY.maxPerSeed);
  assertNonNegativeInt(providerDelayMs, "providerDelayMs", 10_000);
  assertNonNegativeInt(
    batchPauseMs,
    "batchPauseMs",
    LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.maxBatchPauseMs,
  );

  const deps: BackfillDependencies = {
    loadSnapshot: dependencies.loadSnapshot ?? loadLikedArtistSimilarityBackfillSnapshot,
    executeBatch: dependencies.executeBatch ?? executeSimilarityBatch,
    sleep: dependencies.sleep ?? delay,
    now: dependencies.now ?? (() => new Date()),
  };

  const generatedAt = deps.now();
  const before = await deps.loadSnapshot(userId, generatedAt);
  const plan = buildLikedArtistSimilarityBackfillPlan(before, { batchBudget, maxBatches });

  if (mode === "PREVIEW") {
    return materializeReport({
      mode,
      status: previewStatus(before),
      generatedAt,
      batchBudget,
      maxBatches,
      perSeed,
      providerDelayMs,
      batchPauseMs,
      before,
      plan,
      batches: [],
      after: before,
    });
  }

  const batches: LikedArtistSimilarityBackfillBatch[] = [];
  let status: LikedArtistSimilarityBackfillStatus | null = null;

  for (let batch = 1; batch <= maxBatches; batch += 1) {
    const snapshot = await deps.loadSnapshot(userId, deps.now());
    if (snapshot.pendingSources === 0) {
      status = "COMPLETE";
      break;
    }

    let requestedBudget = 0;
    if (snapshot.priorityReadySources > 0) {
      // UNFETCHED/REACTIVATED are selected before STALE by Gate 3. Capping the
      // budget to this exact count prevents unrelated stale refreshes from leaking
      // into a backfill batch.
      requestedBudget = Math.min(batchBudget, snapshot.priorityReadySources);
    } else if (snapshot.retryableFailedSources > 0) {
      if (snapshot.staleSuccessfulSources > 0) {
        status = "STALE_REFRESH_INTERFERENCE_GUARD";
        break;
      }
      requestedBudget = Math.min(batchBudget, snapshot.retryableFailedSources);
    } else if (snapshot.cooldownBlockedSources > 0) {
      status = "BLOCKED_COOLDOWN";
      break;
    } else {
      status = "NO_PROGRESS";
      break;
    }

    const result = await deps.executeBatch(userId, {
      sourceBudget: requestedBudget,
      perSeed,
      providerDelayMs,
    });
    const failureRate =
      result.selectedSources === 0 ? 0 : result.failedSources / result.selectedSources;
    batches.push({
      batch,
      requestedBudget,
      ...result,
      failureRate: rounded(failureRate, 3),
    });

    if (result.selectedSources === 0) {
      status = "NO_PROGRESS";
      break;
    }

    const failureGuardTripped =
      (result.failedSources === result.selectedSources && result.failedSources > 0) ||
      (result.failedSources >=
        LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerFailureGuardMinFailures &&
        failureRate >= LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerFailureGuardRate);
    if (failureGuardTripped) {
      status = "PROVIDER_FAILURE_GUARD";
      break;
    }

    if (batch < maxBatches && batchPauseMs > 0) {
      await deps.sleep(batchPauseMs);
    }
  }

  const after = await deps.loadSnapshot(userId, deps.now());
  if (after.pendingSources === 0) {
    status = "COMPLETE";
  } else if (!status) {
    const blockedStatus = deriveBlockedStatus(after);
    status =
      blockedStatus !== "READY"
        ? blockedStatus
        : batches.length >= maxBatches
          ? "PARTIAL_MAX_BATCHES"
          : "READY";
  }

  return materializeReport({
    mode,
    status,
    generatedAt,
    batchBudget,
    maxBatches,
    perSeed,
    providerDelayMs,
    batchPauseMs,
    before,
    plan,
    batches,
    after,
  });
}

async function executeSimilarityBatch(
  userId: string,
  options: BatchExecutionOptions,
): Promise<BatchExecutionResult> {
  const report = await syncLikedArtistSimilarity(userId, {
    mode: "APPLY",
    sourceBudget: options.sourceBudget,
    perSeed: options.perSeed,
    providerDelayMs: options.providerDelayMs,
  });

  return {
    selectedSources: report.acquisition.selectedSources,
    providerCalls: report.acquisition.providerCalls,
    successfulSources: report.acquisition.successfulSources,
    failedSources: report.acquisition.failedSources,
    beforeActiveSeeds: report.before.activeSeeds,
    afterActiveSeeds: report.after.activeSeeds,
    beforeActiveEdges: report.before.activeEdges,
    afterActiveEdges: report.after.activeEdges,
    failures: report.failures,
  };
}

function materializeReport(input: {
  mode: LikedArtistSimilarityBackfillMode;
  status: LikedArtistSimilarityBackfillStatus;
  generatedAt: Date;
  batchBudget: number;
  maxBatches: number;
  perSeed: number;
  providerDelayMs: number;
  batchPauseMs: number;
  before: LikedArtistSimilarityBackfillSnapshot;
  plan: LikedArtistSimilarityBackfillPlan;
  batches: LikedArtistSimilarityBackfillBatch[];
  after: LikedArtistSimilarityBackfillSnapshot;
}): LikedArtistSimilarityBackfillReport {
  return {
    mode: input.mode,
    status: input.status,
    generatedAt: input.generatedAt,
    policy: {
      batchBudget: input.batchBudget,
      maxBatches: input.maxBatches,
      perSeed: input.perSeed,
      providerDelayMs: input.providerDelayMs,
      batchPauseMs: input.batchPauseMs,
      providerFailureGuardRate:
        LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerFailureGuardRate,
      providerFailureGuardMinFailures:
        LIKED_ARTIST_SIMILARITY_BACKFILL_POLICY.providerFailureGuardMinFailures,
    },
    before: input.before,
    plan: input.plan,
    batches: input.batches,
    after: input.after,
    totals: {
      providerCalls: input.batches.reduce((sum, row) => sum + row.providerCalls, 0),
      successfulSources: input.batches.reduce((sum, row) => sum + row.successfulSources, 0),
      failedSources: input.batches.reduce((sum, row) => sum + row.failedSources, 0),
    },
    safety: {
      shadowOnly: true,
      plannerInfluence: false,
      spotifyWrites: false,
      previewProviderCalls: 0,
      // Any executed APPLY batch may reconcile seed metadata/deactivations even
      // if a concurrent state change leaves zero selected provider sources.
      databaseWrites: input.mode === "APPLY" && input.batches.length > 0,
    },
  };
}

function previewStatus(
  snapshot: LikedArtistSimilarityBackfillSnapshot,
): LikedArtistSimilarityBackfillStatus {
  if (snapshot.pendingSources === 0) return "COMPLETE";
  if (snapshot.priorityReadySources > 0) return "READY";
  if (snapshot.retryableFailedSources > 0 && snapshot.staleSuccessfulSources > 0) {
    return "STALE_REFRESH_INTERFERENCE_GUARD";
  }
  if (snapshot.retryableFailedSources > 0) return "READY";
  if (snapshot.cooldownBlockedSources > 0) return "BLOCKED_COOLDOWN";
  return "NO_PROGRESS";
}

function deriveBlockedStatus(
  snapshot: LikedArtistSimilarityBackfillSnapshot,
): LikedArtistSimilarityBackfillStatus {
  if (snapshot.pendingSources === 0) return "COMPLETE";
  if (snapshot.priorityReadySources > 0) return "READY";
  if (snapshot.retryableFailedSources > 0 && snapshot.staleSuccessfulSources > 0) {
    return "STALE_REFRESH_INTERFERENCE_GUARD";
  }
  if (snapshot.retryableFailedSources > 0) return "READY";
  if (snapshot.cooldownBlockedSources > 0) return "BLOCKED_COOLDOWN";
  return "NO_PROGRESS";
}

function assertPositiveInt(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
}

function assertNonNegativeInt(value: number, name: string, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
}

function rounded(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
