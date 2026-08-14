import { prisma } from "@/lib/prisma";

import {
  inferInferredSkips,
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
  const targets: InferredSkipAnalysisTargetResult[] = [];

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
      targets.push(emptyTargetResult(targetPlaylistId, "NO_APPLIED_GENERATION"));
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

    const recorded = await store.recordInferredSkips({
      userId,
      sourceGenerationRunId: generation.id,
      targetPlaylistId,
      skips: inference.inferredSkips,
    });

    targets.push({
      targetPlaylistId,
      analyzedGenerationRunId: generation.id,
      inferredSkipCount: inference.inferredSkips.length,
      createdSignalCount: recorded.created,
      duplicateSignalCount: recorded.duplicates,
      deferredEdgeTrackId: inference.deferredEdgeTrackId,
      musicSubsequenceLength: inference.musicSubsequenceLength,
      reason: null,
    });
  }

  return { targets };
}

/** MUSIC-05 step 5: pending, not-yet-consumed skip signals keyed by target. */
export async function loadPendingInferredSkips(
  userId: string,
  targetPlaylistIds: readonly string[],
  options: { store?: MusicPreferenceSignalStore } = {},
): Promise<Map<string, PendingSkipSignal[]>> {
  const store = options.store ?? prismaMusicPreferenceSignalStore;
  const byTarget = new Map<string, PendingSkipSignal[]>();
  for (const targetPlaylistId of targetPlaylistIds) {
    byTarget.set(
      targetPlaylistId,
      await store.listPendingSkips(userId, targetPlaylistId),
    );
  }
  return byTarget;
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
