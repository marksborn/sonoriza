import { prisma } from "@/lib/prisma";

import {
  inferInferredSkips,
  type InferredSkip,
  type ObservedPlay,
  type PlannedGenerationItem,
} from "./infer-skips";
import {
  prismaMusicPreferenceSignalStore,
  type MusicPreferenceSignalStore,
  type PendingSkipSignal,
} from "./signal-store";

export type InferredSkipAnalysisTargetResult = {
  targetPlaylistId: string;
  analyzedGenerationRunId: string | null;
  inferredSkipCount: number;
  createdSignalCount: number;
  duplicateSignalCount: number;
  deferredEdgeTrackId: string | null;
  musicSubsequenceLength: number;
  reason: string | null;
};

export type InferredSkipAnalysisResult = {
  targets: InferredSkipAnalysisTargetResult[];
};

type AnalyzeOptions = {
  now?: Date;
  store?: MusicPreferenceSignalStore;
};

type CurrentInference = {
  targetPlaylistId: string;
  analyzedGenerationRunId: string | null;
  inferredSkips: InferredSkip[];
  deferredEdgeTrackId: string | null;
  musicSubsequenceLength: number;
  reason: string | null;
};

/**
 * MUSIC-05 step 3-4: for each target, analyze the most recent applied real
 * generation and persist any inferred skips. Idempotent — re-analyzing the same
 * generation never duplicates signals — and it issues zero Spotify calls: it
 * only reads GenerationItem order (ORDER-01) and TrackListeningEvent history
 * (MUSIC-01) that were already collected.
 */
export async function analyzeAndRecordInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
  options: AnalyzeOptions = {},
): Promise<InferredSkipAnalysisResult> {
  const store = options.store ?? prismaMusicPreferenceSignalStore;
  const current = await analyzeCurrentInferredSkips(userId, targetPlaylistIds);
  const targets: InferredSkipAnalysisTargetResult[] = [];

  for (const target of current) {
    if (!target.analyzedGenerationRunId) {
      targets.push(emptyTargetResult(target.targetPlaylistId, target.reason ?? "NO_APPLIED_GENERATION"));
      continue;
    }

    const recorded = await store.recordInferredSkips({
      userId,
      sourceGenerationRunId: target.analyzedGenerationRunId,
      targetPlaylistId: target.targetPlaylistId,
      skips: target.inferredSkips,
    });

    targets.push({
      targetPlaylistId: target.targetPlaylistId,
      analyzedGenerationRunId: target.analyzedGenerationRunId,
      inferredSkipCount: target.inferredSkips.length,
      createdSignalCount: recorded.created,
      duplicateSignalCount: recorded.duplicates,
      deferredEdgeTrackId: target.deferredEdgeTrackId,
      musicSubsequenceLength: target.musicSubsequenceLength,
      reason: target.reason,
    });
  }

  return { targets };
}

/**
 * MUSIC-05 step 5: pending, not-yet-consumed skip signals keyed by target.
 *
 * With the default Prisma store, this also performs the same current skip
 * inference read-only and exposes any not-yet-recorded signal as a synthetic
 * preview row. This keeps ORDER-01 simulation and real generation on the same
 * planning state without writing preference signals during simulation.
 *
 * Existing signals are checked regardless of consumed state, so a signal that
 * has already been consumed is never resurrected by the read-only preview.
 * Custom stores keep the historical list-only behavior unless
 * `includeCurrentInference` is explicitly requested.
 */
export async function loadPendingInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
  options: {
    store?: MusicPreferenceSignalStore;
    includeCurrentInference?: boolean;
  } = {},
): Promise<Map<string, PendingSkipSignal[]>> {
  const store = options.store ?? prismaMusicPreferenceSignalStore;
  const includeCurrentInference =
    options.includeCurrentInference ?? options.store === undefined;
  const byTarget = new Map<string, PendingSkipSignal[]>();

  for (const targetPlaylistId of targetPlaylistIds) {
    byTarget.set(
      targetPlaylistId,
      await store.listPendingSkips(userId, targetPlaylistId),
    );
  }

  if (!includeCurrentInference) return byTarget;

  const current = await analyzeCurrentInferredSkips(userId, targetPlaylistIds);

  for (const target of current) {
    const generationRunId = target.analyzedGenerationRunId;
    if (!generationRunId || target.inferredSkips.length === 0) continue;

    const positions = [...new Set(target.inferredSkips.map((skip) => skip.position))];
    const existingSignals = await prisma.musicPreferenceSignal.findMany({
      where: {
        userId,
        type: "INFERRED_SKIP",
        sourceGenerationRunId: generationRunId,
        targetPlaylistId: target.targetPlaylistId,
        position: { in: positions },
      },
      select: { position: true },
    });
    const existingPositions = new Set(existingSignals.map((signal) => signal.position));
    const pending = byTarget.get(target.targetPlaylistId) ?? [];

    for (const skip of target.inferredSkips) {
      if (existingPositions.has(skip.position)) continue;
      pending.push({
        id: previewSignalId(generationRunId, target.targetPlaylistId, skip.position),
        spotifyTrackId: skip.spotifyTrackId,
        spotifyUri: skip.spotifyUri,
        position: skip.position,
        sourceGenerationRunId: generationRunId,
        targetPlaylistId: target.targetPlaylistId,
      });
    }

    byTarget.set(target.targetPlaylistId, pending);
  }

  return byTarget;
}

async function analyzeCurrentInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
): Promise<CurrentInference[]> {
  const targets: CurrentInference[] = [];

  // The most recent observed play is inconclusive for this collection.
  const latestEvent = await prisma.trackListeningEvent.findFirst({
    where: { userId, spotifyTrackId: { not: null } },
    orderBy: { playedAt: "desc" },
    select: { spotifyTrackId: true, playedAt: true },
  });
  const latestObservedPlay: ObservedPlay | null =
    latestEvent?.spotifyTrackId != null
      ? { spotifyTrackId: latestEvent.spotifyTrackId, playedAt: latestEvent.playedAt }
      : null;

  for (const targetPlaylistId of targetPlaylistIds) {
    const generation = await prisma.generationRun.findFirst({
      where: {
        userId,
        simulation: false,
        status: { in: ["SUCCESS", "PARTIAL"] },
        items: { some: { targetPlaylistId } },
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        startedAt: true,
        finishedAt: true,
        items: {
          where: { targetPlaylistId },
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            contentType: true,
            spotifyUri: true,
            spotifyTrackId: true,
          },
        },
      },
    });

    if (!generation) {
      targets.push({
        targetPlaylistId,
        analyzedGenerationRunId: null,
        inferredSkips: [],
        deferredEdgeTrackId: null,
        musicSubsequenceLength: 0,
        reason: "NO_APPLIED_GENERATION",
      });
      continue;
    }

    const appliedAt = generation.finishedAt ?? generation.startedAt;
    const orderedItems: PlannedGenerationItem[] = generation.items.map((item) => ({
      position: item.position,
      contentType: item.contentType,
      spotifyTrackId: item.spotifyTrackId,
      spotifyUri: item.spotifyUri,
      generationItemId: item.id,
    }));

    const playRows = await prisma.trackListeningEvent.findMany({
      where: {
        userId,
        spotifyTrackId: { not: null },
        playedAt: { gte: appliedAt },
      },
      select: { spotifyTrackId: true, playedAt: true },
    });
    const plays: ObservedPlay[] = playRows.flatMap((row) =>
      row.spotifyTrackId
        ? [{ spotifyTrackId: row.spotifyTrackId, playedAt: row.playedAt }]
        : [],
    );

    const inference = inferInferredSkips({
      orderedItems,
      plays,
      latestObservedPlay,
      generationAppliedAt: appliedAt,
    });

    targets.push({
      targetPlaylistId,
      analyzedGenerationRunId: generation.id,
      inferredSkips: inference.inferredSkips,
      deferredEdgeTrackId: inference.deferredEdgeTrackId,
      musicSubsequenceLength: inference.musicSubsequenceLength,
      reason: null,
    });
  }

  return targets;
}

function previewSignalId(
  sourceGenerationRunId: string,
  targetPlaylistId: string,
  position: number,
): string {
  return `preview:${sourceGenerationRunId}:${targetPlaylistId}:${position}`;
}

function emptyTargetResult(
  targetPlaylistId: string,
  reason: string,
): InferredSkipAnalysisTargetResult {
  return {
    targetPlaylistId,
    analyzedGenerationRunId: null,
    inferredSkipCount: 0,
    createdSignalCount: 0,
    duplicateSignalCount: 0,
    deferredEdgeTrackId: null,
    musicSubsequenceLength: 0,
    reason,
  };
}
