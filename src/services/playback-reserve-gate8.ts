import { prisma } from "@/lib/prisma";
import type { KeepFilledTargetPatch } from "@/services/keep-filled-maintenance";
import type { Candidate } from "@/services/playlist-planner";

import {
  buildGenerationPlanItemRoleIndex,
  generationRunPlanRolesAreSafeForBehavioralEvidence,
  resolveGenerationPlanItemRole,
} from "./playback-reserve-gate6";

export type PlaybackReserveGate8KeepFilledContext = Readonly<{
  snapshotBefore: string;
  previousRunId: string | null;
  previousReserveCount: number;
  previousReserveDurationMs: number;
}>;

export type PlaybackReserveGate8PreparedInput = Readonly<{
  preservedByTargetId: Record<string, Candidate[]>;
  keepFilledByTargetId: Record<string, KeepFilledTargetPatch>;
  contextByTargetId: Record<string, PlaybackReserveGate8KeepFilledContext>;
}>;

/**
 * PLAYBACK-RESERVE-01 Gate 8 KEEP_FILLED provenance boundary.
 *
 * SCHEDULE-01 prepares every still-valid remote item as a stable prefix. Once a
 * productive reserve exists, that is not sufficient: an old RESERVE suffix is
 * valid remote content, but it must never consume the next run's PRIMARY
 * duration budget. This adapter reconstructs the last explicit plan roles,
 * removes old RESERVE items from the preserved PRIMARY prefix, and moves those
 * live reserve URIs into the maintenance removal set.
 *
 * Historical/SHADOW runs remain backward compatible because missing role rows
 * mean PRIMARY. An ACTIVE Gate 7/8 run whose role sidecar was not persisted is
 * unsafe to reinterpret and therefore fails closed before planning/write.
 */
export async function preparePlaybackReserveGate8KeepFilledInput(input: {
  userId: string;
  targetPlaylistIds?: readonly string[];
  preservedByTargetId?: Readonly<Record<string, Candidate[]>>;
  keepFilledByTargetId?: Readonly<Record<string, KeepFilledTargetPatch>>;
  scheduledPolicyByTargetId?: Readonly<
    Record<string, "KEEP_FILLED" | "REBUILD_DAILY">
  >;
}): Promise<PlaybackReserveGate8PreparedInput> {
  const preservedByTargetId = cloneCandidateRecord(input.preservedByTargetId);
  const keepFilledByTargetId = clonePatchRecord(input.keepFilledByTargetId);
  const contextByTargetId: Record<string, PlaybackReserveGate8KeepFilledContext> = {};
  const targetPlaylistIds = [
    ...new Set((input.targetPlaylistIds ?? []).map((value) => value.trim()).filter(Boolean)),
  ];

  for (const targetPlaylistId of targetPlaylistIds) {
    if (input.scheduledPolicyByTargetId?.[targetPlaylistId] !== "KEEP_FILLED") {
      continue;
    }
    const patch = keepFilledByTargetId[targetPlaylistId];
    if (!patch?.snapshotBefore) continue;

    const previousRun = await prisma.generationRun.findFirst({
      where: {
        userId: input.userId,
        simulation: false,
        status: { in: ["SUCCESS", "PARTIAL"] },
        items: { some: { targetPlaylistId } },
      },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        summary: true,
        items: {
          where: { targetPlaylistId },
          select: {
            targetPlaylistId: true,
            position: true,
            spotifyUri: true,
            durationMs: true,
          },
        },
      },
    });

    if (!previousRun) {
      contextByTargetId[targetPlaylistId] = Object.freeze({
        snapshotBefore: patch.snapshotBefore,
        previousRunId: null,
        previousReserveCount: 0,
        previousReserveDurationMs: 0,
      });
      continue;
    }

    if (!generationRunPlanRolesAreSafeForBehavioralEvidence(previousRun.summary)) {
      throw new Error(
        `PLAYBACK-RESERVE Gate 8 refused KEEP_FILLED for ${targetPlaylistId}: ` +
          `previous ACTIVE run ${previousRun.id} has no trustworthy PRIMARY/RESERVE sidecar.`,
      );
    }

    const roleRows = await prisma.generationPlanItemRole.findMany({
      where: { runId: previousRun.id, targetPlaylistId },
      select: {
        runId: true,
        targetPlaylistId: true,
        position: true,
        role: true,
      },
    });
    const roleIndex = buildGenerationPlanItemRoleIndex(roleRows);
    const previousReserveItems = previousRun.items.filter(
      (item) =>
        resolveGenerationPlanItemRole(roleIndex, {
          runId: previousRun.id,
          targetPlaylistId,
          position: item.position,
        }) === "RESERVE",
    );
    const reserveUriSet = new Set(previousReserveItems.map((item) => item.spotifyUri));

    const preserved = preservedByTargetId[targetPlaylistId] ?? [];
    const stalePreservedReserve = preserved.filter((item) => reserveUriSet.has(item.uri));
    const stalePreservedReserveUris = new Set(
      stalePreservedReserve.map((item) => item.uri),
    );

    preservedByTargetId[targetPlaylistId] = preserved.filter(
      (item) => !reserveUriSet.has(item.uri),
    );

    const previousDurationByUri = new Map(
      previousReserveItems.map((item) => [item.spotifyUri, Math.max(0, item.durationMs)] as const),
    );
    const knownLiveReserveUris = new Set([
      ...patch.preservedUris.filter((uri) => reserveUriSet.has(uri)),
      ...patch.removeUris.filter((uri) => reserveUriSet.has(uri)),
    ]);
    const previousReserveDurationMs = [...knownLiveReserveUris].reduce(
      (sum, uri) => sum + (previousDurationByUri.get(uri) ?? 0),
      0,
    );
    const newlyRemovedDurationMs = stalePreservedReserve.reduce(
      (sum, item) => sum + Math.max(0, item.durationMs),
      0,
    );

    keepFilledByTargetId[targetPlaylistId] = {
      ...patch,
      preservedUris: patch.preservedUris.filter((uri) => !reserveUriSet.has(uri)),
      removeUris: [
        ...new Set([
          ...patch.removeUris,
          ...stalePreservedReserve.map((item) => item.uri),
        ]),
      ],
      validDurationBeforeMs: Math.max(
        0,
        patch.validDurationBeforeMs - newlyRemovedDurationMs,
      ),
      removedDurationMs: patch.removedDurationMs + newlyRemovedDurationMs,
      preservedCount: Math.max(0, patch.preservedCount - stalePreservedReserve.length),
      removedCount: patch.removedCount + stalePreservedReserveUris.size,
    };

    contextByTargetId[targetPlaylistId] = Object.freeze({
      snapshotBefore: patch.snapshotBefore,
      previousRunId: previousRun.id,
      previousReserveCount: knownLiveReserveUris.size,
      previousReserveDurationMs,
    });
  }

  return {
    preservedByTargetId,
    keepFilledByTargetId,
    contextByTargetId,
  };
}

function cloneCandidateRecord(
  input: Readonly<Record<string, Candidate[]>> | undefined,
): Record<string, Candidate[]> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([targetPlaylistId, candidates]) => [
      targetPlaylistId,
      [...candidates],
    ]),
  );
}

function clonePatchRecord(
  input: Readonly<Record<string, KeepFilledTargetPatch>> | undefined,
): Record<string, KeepFilledTargetPatch> {
  return Object.fromEntries(
    Object.entries(input ?? {}).map(([targetPlaylistId, patch]) => [
      targetPlaylistId,
      {
        ...patch,
        preservedUris: [...patch.preservedUris],
        removeUris: [...patch.removeUris],
      },
    ]),
  );
}
