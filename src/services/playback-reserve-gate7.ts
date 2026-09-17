import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  currentPlaybackReserveShadowRuntimeState,
  recordPlaybackReserveRolePersistence,
} from "@/services/playback-reserve-shadow-runtime";

export type Gate7PlannedTarget = Readonly<{
  targetPlaylistId: string;
  result: Readonly<{
    items: readonly Readonly<{
      position: number;
      uri: string;
    }>[];
  }>;
}>;

/**
 * PLAYBACK-RESERVE-01 Gate 7 pre-write persistence seam.
 *
 * ACTIVE reserve roles are persisted before any Spotify writer is created. The
 * sidecar intentionally has no GenerationItem FK, so it can safely establish
 * semantic provenance first; the normal generator persists GenerationItem rows
 * after the remote write. Failed/aborted runs are already excluded by MUSIC-06
 * and MUSIC-07 through GenerationRun status.
 *
 * Any ACTIVE role-persistence failure throws and therefore blocks the remote
 * write. SHADOW/OFF are strict no-ops.
 */
export async function persistPlaybackReserveRolesBeforeWrite(input: {
  runId: string;
  targets: readonly Gate7PlannedTarget[];
}): Promise<void> {
  const state = currentPlaybackReserveShadowRuntimeState();
  if (!state || state.effectiveMode !== "ACTIVE") return;

  try {
    if (!state.evidence || state.evidence.mode !== "ACTIVE") {
      throw new Error("Gate 7 ACTIVE plan is missing reserve evidence.");
    }

    const targetById = new Map(
      input.targets.map((target) => [target.targetPlaylistId, target] as const),
    );
    const rows: Prisma.GenerationPlanItemRoleCreateManyInput[] = [];

    for (const evidence of state.evidence.targets) {
      if (!("reserve" in evidence) || !evidence.reserve) continue;
      const target = targetById.get(evidence.targetPlaylistId);
      if (!target) {
        throw new Error(
          `Gate 7 reserve evidence references missing target ${evidence.targetPlaylistId}.`,
        );
      }
      const policy = state.policies.get(evidence.targetPlaylistId);
      if (!policy || policy.reserveMode === "NONE") {
        throw new Error(
          `Gate 7 reserve evidence has no productive policy for ${evidence.targetPlaylistId}.`,
        );
      }

      const plannedByPosition = new Map(
        target.result.items.map((item) => [item.position, item] as const),
      );

      for (const selected of evidence.reserve.selectedItems) {
        const planned = plannedByPosition.get(selected.position);
        if (!planned || planned.uri !== selected.uri) {
          throw new Error(
            `Gate 7 RESERVE item does not match physical plan at ${evidence.targetPlaylistId}:${selected.position}.`,
          );
        }

        rows.push({
          runId: input.runId,
          targetPlaylistId: evidence.targetPlaylistId,
          position: selected.position,
          role: "RESERVE",
          reservePolicy: {
            targetPlaylistId: policy.targetPlaylistId,
            source: policy.source,
            reserveMode: policy.reserveMode,
            durationSeconds: policy.durationSeconds,
            musicTrackCount: policy.musicTrackCount,
            podcastEpisodeCount: policy.podcastEpisodeCount,
            podcastInDurationReserve: policy.podcastInDurationReserve,
          } satisfies Prisma.InputJsonObject,
        });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.generationPlanItemRole.deleteMany({ where: { runId: input.runId } });
      if (rows.length > 0) {
        await tx.generationPlanItemRole.createMany({ data: rows });
      }
    });

    recordPlaybackReserveRolePersistence({
      status: "PERSISTED",
      reserveRoleCount: rows.length,
    });
  } catch (error) {
    recordPlaybackReserveRolePersistence({ status: "FAILED" });
    throw error;
  }
}
