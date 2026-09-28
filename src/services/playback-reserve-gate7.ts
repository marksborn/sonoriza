import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { PlaybackReserveShadowRuntimeState } from "@/services/playback-reserve-shadow-runtime";

/**
 * PLAYBACK-RESERVE-01 Gate 7/8 role persistence.
 *
 * The outer PLAYBACK-RESERVE generator seam persists the explicit RESERVE
 * sidecar immediately after the canonical generator has persisted GenerationItem
 * rows. This keeps the large incremental generator untouched. If persistence
 * fails after a remote write, the wrapper records FAILED and returns the
 * original generation result (never creating an automatic retry hazard); Gate 6
 * consumers fail closed for that ACTIVE run.
 *
 * ORDER-01/MUSIC-06 may rerank MUSIC identities inside the RESERVE suffix after
 * reserve selection. Persistence therefore validates the final physical suffix
 * as a set + contiguous region, rather than requiring the pre-order URI to stay
 * at the exact same coordinate. The RESERVE boundary remains strict: any URI
 * crossing into/out of the suffix still fails closed.
 */
export async function persistPlaybackReserveRolesAfterGeneration(input: {
  runId: string;
  state: PlaybackReserveShadowRuntimeState;
}): Promise<number> {
  const { state } = input;
  if (state.effectiveMode !== "ACTIVE") return 0;
  const gate = state.gate >= 8 ? 8 : 7;
  if (!state.evidence || state.evidence.mode !== "ACTIVE") {
    throw new Error(`Gate ${gate} ACTIVE generation is missing reserve evidence.`);
  }

  const generationItems = await prisma.generationItem.findMany({
    where: { runId: input.runId },
    orderBy: [{ targetPlaylistId: "asc" }, { position: "asc" }],
    select: {
      targetPlaylistId: true,
      position: true,
      spotifyUri: true,
    },
  });

  const rows: Prisma.GenerationPlanItemRoleCreateManyInput[] = [];
  for (const evidence of state.evidence.targets) {
    if (!("reserve" in evidence) || !evidence.reserve) continue;
    const policy = state.policies.get(evidence.targetPlaylistId);
    if (!policy || policy.reserveMode === "NONE") {
      throw new Error(
        `Gate ${gate} reserve evidence has no productive policy for ${evidence.targetPlaylistId}.`,
      );
    }

    const selectedItems = [...evidence.reserve.selectedItems];
    const startsAtPosition = evidence.reserve.startsAtPosition;
    const targetItems = generationItems.filter(
      (item) => item.targetPlaylistId === evidence.targetPlaylistId,
    );
    const physicalReserve = targetItems.filter(
      (item) => item.position >= startsAtPosition,
    );

    if (physicalReserve.length !== selectedItems.length) {
      throw new Error(
        `Gate ${gate} physical RESERVE suffix cardinality mismatch for ${evidence.targetPlaylistId}: ` +
          `expected ${selectedItems.length}, found ${physicalReserve.length}.`,
      );
    }

    for (const [index, physical] of physicalReserve.entries()) {
      const expectedPosition = startsAtPosition + index;
      if (physical.position !== expectedPosition) {
        throw new Error(
          `Gate ${gate} physical RESERVE suffix is not contiguous for ${evidence.targetPlaylistId}: ` +
            `expected position ${expectedPosition}, found ${physical.position}.`,
        );
      }
    }

    const expectedUris = new Set(selectedItems.map((item) => item.uri));
    const physicalUris = new Set(physicalReserve.map((item) => item.spotifyUri));
    if (expectedUris.size !== selectedItems.length) {
      throw new Error(
        `Gate ${gate} reserve evidence contains duplicate URIs for ${evidence.targetPlaylistId}.`,
      );
    }
    if (physicalUris.size !== physicalReserve.length) {
      throw new Error(
        `Gate ${gate} physical RESERVE suffix contains duplicate URIs for ${evidence.targetPlaylistId}.`,
      );
    }
    for (const uri of expectedUris) {
      if (!physicalUris.has(uri)) {
        throw new Error(
          `Gate ${gate} physical RESERVE suffix does not match selected reserve set for ${evidence.targetPlaylistId}: missing ${uri}.`,
        );
      }
    }
    for (const uri of physicalUris) {
      if (!expectedUris.has(uri)) {
        throw new Error(
          `Gate ${gate} physical RESERVE suffix does not match selected reserve set for ${evidence.targetPlaylistId}: unexpected ${uri}.`,
        );
      }
    }

    for (const physical of physicalReserve) {
      rows.push({
        runId: input.runId,
        targetPlaylistId: evidence.targetPlaylistId,
        position: physical.position,
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
