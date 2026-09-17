import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { PlaybackReserveShadowRuntimeState } from "@/services/playback-reserve-shadow-runtime";

/**
 * PLAYBACK-RESERVE-01 Gate 7 role persistence.
 *
 * The outer PLAYBACK-RESERVE generator seam persists the explicit RESERVE
 * sidecar immediately after the canonical generator has persisted GenerationItem
 * rows. This keeps the large incremental generator untouched. If persistence
 * fails after a remote write, the wrapper records FAILED and returns the
 * original generation result (never creating an automatic retry hazard); Gate 6
 * consumers fail closed for that ACTIVE run.
 */
export async function persistPlaybackReserveRolesAfterGeneration(input: {
  runId: string;
  state: PlaybackReserveShadowRuntimeState;
}): Promise<number> {
  const { state } = input;
  if (state.effectiveMode !== "ACTIVE") return 0;
  if (!state.evidence || state.evidence.mode !== "ACTIVE") {
    throw new Error("Gate 7 ACTIVE generation is missing reserve evidence.");
  }

  const generationItems = await prisma.generationItem.findMany({
    where: { runId: input.runId },
    select: {
      targetPlaylistId: true,
      position: true,
      spotifyUri: true,
    },
  });
  const physicalByCoordinate = new Map(
    generationItems.map((item) => [
      `${item.targetPlaylistId}\u0000${item.position}`,
      item,
    ] as const),
  );

  const rows: Prisma.GenerationPlanItemRoleCreateManyInput[] = [];
  for (const evidence of state.evidence.targets) {
    if (!("reserve" in evidence) || !evidence.reserve) continue;
    const policy = state.policies.get(evidence.targetPlaylistId);
    if (!policy || policy.reserveMode === "NONE") {
      throw new Error(
        `Gate 7 reserve evidence has no productive policy for ${evidence.targetPlaylistId}.`,
      );
    }

    for (const selected of evidence.reserve.selectedItems) {
      const physical = physicalByCoordinate.get(
        `${evidence.targetPlaylistId}\u0000${selected.position}`,
      );
      if (!physical || physical.spotifyUri !== selected.uri) {
        throw new Error(
          `Gate 7 RESERVE item does not match persisted GenerationItem at ${evidence.targetPlaylistId}:${selected.position}.`,
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

  return rows.length;
}
