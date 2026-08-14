import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import type { InferredSkip } from "./infer-skips";

export type RecordInferredSkipsInput = {
  userId: string;
  sourceGenerationRunId: string;
  targetPlaylistId: string;
  skips: readonly InferredSkip[];
};

export type RecordInferredSkipsResult = {
  created: number;
  duplicates: number;
};

export type PendingSkipSignal = {
  id: string;
  spotifyTrackId: string;
  spotifyUri: string | null;
  position: number;
  sourceGenerationRunId: string;
  targetPlaylistId: string;
};

/**
 * Persistence boundary for MUSIC-05 signals. Idempotent on
 * (userId, type, sourceGenerationRunId, targetPlaylistId, position): re-analyzing
 * the same generation and position never duplicates, and a signal is consumed at
 * most once.
 */
export type MusicPreferenceSignalStore = {
  recordInferredSkips(
    input: RecordInferredSkipsInput,
  ): Promise<RecordInferredSkipsResult>;
  listPendingSkips(
    userId: string,
    targetPlaylistId: string,
  ): Promise<PendingSkipSignal[]>;
  consume(
    userId: string,
    signalIds: readonly string[],
    consumedByRunId: string,
    consumedAt: Date,
  ): Promise<number>;
};

export const prismaMusicPreferenceSignalStore: MusicPreferenceSignalStore = {
  async recordInferredSkips({
    userId,
    sourceGenerationRunId,
    targetPlaylistId,
    skips,
  }) {
    if (skips.length === 0) return { created: 0, duplicates: 0 };

    const result = await prisma.musicPreferenceSignal.createMany({
      data: skips.map((skip) => ({
        userId,
        spotifyTrackId: skip.spotifyTrackId,
        spotifyUri: skip.spotifyUri,
        type: "INFERRED_SKIP" as const,
        sourceGenerationRunId,
        targetPlaylistId,
        generationItemId: skip.generationItemId,
        position: skip.position,
        confidence: skip.confidence,
        evidence: skip.evidence as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });

    return {
      created: result.count,
      duplicates: skips.length - result.count,
    };
  },

  async listPendingSkips(userId, targetPlaylistId) {
    const rows = await prisma.musicPreferenceSignal.findMany({
      where: {
        userId,
        targetPlaylistId,
        type: "INFERRED_SKIP",
        consumedAt: null,
      },
      select: {
        id: true,
        spotifyTrackId: true,
        spotifyUri: true,
        position: true,
        sourceGenerationRunId: true,
        targetPlaylistId: true,
      },
    });
    return rows;
  },

  async consume(userId, signalIds, consumedByRunId, consumedAt) {
    if (signalIds.length === 0) return 0;
    const result = await prisma.musicPreferenceSignal.updateMany({
      where: {
        userId,
        id: { in: [...signalIds] },
        consumedAt: null,
      },
      data: { consumedAt, consumedByRunId },
    });
    return result.count;
  },
};

type VolatileRow = {
  id: string;
  userId: string;
  spotifyTrackId: string;
  spotifyUri: string | null;
  sourceGenerationRunId: string;
  targetPlaylistId: string;
  position: number;
  consumedAt: Date | null;
  consumedByRunId: string | null;
};

/** In-memory store mirroring the Prisma semantics for unit tests. */
export function createVolatileMusicPreferenceSignalStore(): MusicPreferenceSignalStore {
  const rows: VolatileRow[] = [];
  let sequence = 0;

  const key = (row: {
    userId: string;
    sourceGenerationRunId: string;
    targetPlaylistId: string;
    position: number;
  }): string =>
    [
      row.userId,
      row.sourceGenerationRunId,
      row.targetPlaylistId,
      row.position,
    ].join("::");

  return {
    async recordInferredSkips({
      userId,
      sourceGenerationRunId,
      targetPlaylistId,
      skips,
    }) {
      const existing = new Set(rows.map((row) => key(row)));
      let created = 0;
      let duplicates = 0;

      for (const skip of skips) {
        const identity = key({
          userId,
          sourceGenerationRunId,
          targetPlaylistId,
          position: skip.position,
        });
        if (existing.has(identity)) {
          duplicates += 1;
          continue;
        }
        existing.add(identity);
        sequence += 1;
        rows.push({
          id: `signal-${sequence}`,
          userId,
          spotifyTrackId: skip.spotifyTrackId,
          spotifyUri: skip.spotifyUri,
          sourceGenerationRunId,
          targetPlaylistId,
          position: skip.position,
          consumedAt: null,
          consumedByRunId: null,
        });
        created += 1;
      }

      return { created, duplicates };
    },

    async listPendingSkips(userId, targetPlaylistId) {
      return rows
        .filter(
          (row) =>
            row.userId === userId &&
            row.targetPlaylistId === targetPlaylistId &&
            row.consumedAt === null,
        )
        .map((row) => ({
          id: row.id,
          spotifyTrackId: row.spotifyTrackId,
          spotifyUri: row.spotifyUri,
          position: row.position,
          sourceGenerationRunId: row.sourceGenerationRunId,
          targetPlaylistId: row.targetPlaylistId,
        }));
    },

    async consume(userId, signalIds, consumedByRunId, consumedAt) {
      const ids = new Set(signalIds);
      let count = 0;
      for (const row of rows) {
        if (
          row.userId === userId &&
          ids.has(row.id) &&
          row.consumedAt === null
        ) {
          row.consumedAt = consumedAt;
          row.consumedByRunId = consumedByRunId;
          count += 1;
        }
      }
      return count;
    },
  };
}
