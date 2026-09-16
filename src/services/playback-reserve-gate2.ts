import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  defaultPlaybackReservePolicy,
  defaultTargetPlaybackReservePolicy,
  normalizeGenerationPlanRole,
  normalizePlaybackReservePolicy,
  normalizeTargetPlaybackReservePolicy,
  resolveEffectivePlaybackReservePolicy,
  type EffectivePlaybackReservePolicySnapshot,
  type GenerationPlanRoleValue,
} from "./playback-reserve-policy";

export type PlaybackReserveFingerprintEntry = Readonly<{
  targetPlaylistId: string;
  source: "GLOBAL" | "TARGET_OVERRIDE";
  reserveMode: EffectivePlaybackReservePolicySnapshot["reserveMode"];
  durationSeconds: number | null;
  musicTrackCount: number | null;
  podcastEpisodeCount: number | null;
  podcastInDurationReserve: EffectivePlaybackReservePolicySnapshot["podcastInDurationReserve"];
}>;

export type GenerationPlanItemRoleInput = Readonly<{
  runId: string;
  targetPlaylistId: string;
  position: number;
  role?: GenerationPlanRoleValue | null;
  reservePolicy?: EffectivePlaybackReservePolicySnapshot | null;
}>;

export async function loadPlaybackReserveFingerprintEntries(
  userId: string,
  targetPlaylistIds: readonly string[],
): Promise<PlaybackReserveFingerprintEntry[]> {
  const normalizedUserId = requiredId(userId, "userId");
  const targetIds = [
    ...new Set(
      targetPlaylistIds
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();

  if (targetIds.length === 0) return [];

  const [globalRow, targetRows] = await Promise.all([
    prisma.playbackReservePolicy.findUnique({
      where: { userId: normalizedUserId },
    }),
    prisma.targetPlaybackReservePolicy.findMany({
      where: {
        userId: normalizedUserId,
        targetPlaylistId: { in: targetIds },
      },
    }),
  ]);

  const globalPolicy = globalRow
    ? normalizePlaybackReservePolicy({
        reserveMode: globalRow.reserveMode,
        durationSeconds: globalRow.durationSeconds,
        musicTrackCount: globalRow.musicTrackCount,
        podcastEpisodeCount: globalRow.podcastEpisodeCount,
        podcastInDurationReserve: globalRow.podcastInDurationReserve,
      })
    : defaultPlaybackReservePolicy();

  const targetRowsById = new Map(
    targetRows.map((row) => [row.targetPlaylistId, row] as const),
  );

  return targetIds.map((targetPlaylistId) => {
    const row = targetRowsById.get(targetPlaylistId);
    const targetPolicy = row
      ? normalizeTargetPlaybackReservePolicy(targetPlaylistId, {
          policyMode: row.policyMode,
          reserveMode: row.reserveMode,
          durationSeconds: row.durationSeconds,
          musicTrackCount: row.musicTrackCount,
          podcastEpisodeCount: row.podcastEpisodeCount,
          podcastInDurationReserve: row.podcastInDurationReserve,
        })
      : defaultTargetPlaybackReservePolicy(targetPlaylistId);

    const effective = resolveEffectivePlaybackReservePolicy(
      targetPlaylistId,
      globalPolicy,
      targetPolicy,
    );

    return Object.freeze({
      targetPlaylistId: effective.targetPlaylistId,
      source: effective.source,
      reserveMode: effective.reserveMode,
      durationSeconds: effective.durationSeconds,
      musicTrackCount: effective.musicTrackCount,
      podcastEpisodeCount: effective.podcastEpisodeCount,
      podcastInDurationReserve: effective.podcastInDurationReserve,
    });
  });
}

/**
 * Backward-compatible fingerprint fragment.
 *
 * When every effective target policy is NONE the feature cannot change the
 * published plan, so the fragment is omitted entirely and legacy fingerprints
 * remain byte-for-byte stable. As soon as one target can produce reserve
 * content, the complete target-local policy set participates in the fingerprint
 * (including GLOBAL vs TARGET_OVERRIDE provenance and explicit NONE overrides).
 */
export function playbackReserveFingerprintPayloadFragment(
  entries: readonly PlaybackReserveFingerprintEntry[],
): Readonly<Record<string, unknown>> {
  if (!entries.some((entry) => entry.reserveMode !== "NONE")) {
    return Object.freeze({});
  }

  const normalized = [...entries]
    .map((entry) => Object.freeze({ ...entry }))
    .sort((left, right) =>
      left.targetPlaylistId.localeCompare(right.targetPlaylistId),
    );

  return Object.freeze({
    playbackReservePolicies: Object.freeze(normalized),
  });
}

/**
 * Gate 2 persistence contract. This sidecar records the role explicitly for an
 * exact generated-item coordinate; callers never infer RESERVE from a duration
 * boundary or from `position > X`.
 *
 * Gate 2 does not call this from the generator yet. Later runtime gates can do
 * so after PRIMARY is certified and RESERVE has been planned.
 */
export async function persistGenerationPlanItemRole(
  input: GenerationPlanItemRoleInput,
): Promise<void> {
  const runId = requiredId(input.runId, "runId");
  const targetPlaylistId = requiredId(
    input.targetPlaylistId,
    "targetPlaylistId",
  );
  const position = nonNegativeInteger(input.position, "position");
  const role = normalizeGenerationPlanRole(input.role);

  let reservePolicy: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;

  if (role === "PRIMARY") {
    if (input.reservePolicy != null) {
      throw new Error("PRIMARY items cannot carry a reserve policy snapshot.");
    }
  } else {
    if (!input.reservePolicy) {
      throw new Error("RESERVE items require an effective reserve policy snapshot.");
    }
    if (input.reservePolicy.targetPlaylistId !== targetPlaylistId) {
      throw new Error("Reserve policy target does not match targetPlaylistId.");
    }
    if (input.reservePolicy.reserveMode === "NONE") {
      throw new Error("RESERVE items cannot be produced by reserveMode NONE.");
    }

    reservePolicy = {
      targetPlaylistId: input.reservePolicy.targetPlaylistId,
      source: input.reservePolicy.source,
      reserveMode: input.reservePolicy.reserveMode,
      durationSeconds: input.reservePolicy.durationSeconds,
      musicTrackCount: input.reservePolicy.musicTrackCount,
      podcastEpisodeCount: input.reservePolicy.podcastEpisodeCount,
      podcastInDurationReserve: input.reservePolicy.podcastInDurationReserve,
    } satisfies Prisma.InputJsonObject;
  }

  await prisma.generationPlanItemRole.upsert({
    where: {
      runId_targetPlaylistId_position: {
        runId,
        targetPlaylistId,
        position,
      },
    },
    create: {
      runId,
      targetPlaylistId,
      position,
      role,
      reservePolicy,
    },
    update: {
      role,
      reservePolicy,
    },
  });
}

export async function loadGenerationPlanItemRoles(
  runId: string,
  targetPlaylistId: string,
) {
  return prisma.generationPlanItemRole.findMany({
    where: {
      runId: requiredId(runId, "runId"),
      targetPlaylistId: requiredId(targetPlaylistId, "targetPlaylistId"),
    },
    orderBy: { position: "asc" },
  });
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}
