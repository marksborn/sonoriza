import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  createPodcast09ShadowRuntimeState,
  podcast09ShadowRuntimeSummary,
  runWithPodcast09ShadowRuntimeState,
} from "@/services/playlist-planner/podcast-continuation-shadow-runtime";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions as BaseGeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-music-identity";

export type GeneratePlaylistsOptions = BaseGeneratePlaylistsOptions & {
  /** PODCAST-09: factual episode order already present in each target. */
  currentDestinationEpisodeIdsByTargetId?: Record<string, string[]>;
};
export type { GeneratePlaylistsResult } from "./generate-playlists-music-identity";

/**
 * PODCAST-09 Gate 5 controlled generation boundary.
 *
 * With no explicit PODCAST-09 configuration this is strict delegation. SHADOW
 * records the destination-local continuation projection without planner
 * influence. ACTIVE simulation keeps the Gate 4 exact pair + target guards.
 *
 * Gate 5 permits a continuation-influenced real run only when all Gate 4 guards
 * pass, the trigger is MANUAL and the exact userId:targetPlaylistId pair is also
 * present in PODCAST_09_REAL_ACTIVE_ALLOWLIST. SCHEDULED real runs therefore
 * remain SHADOW even if the real allowlist is accidentally populated.
 *
 * Current target episode order must be supplied by an upstream factual target
 * state read; PODCAST-09 performs no provider read of its own.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetAllowlist = process.env.PODCAST_09_SHADOW_TARGET_ALLOWLIST ?? "";
  const configuredMode = process.env.PODCAST_09_PLANNER_MODE?.trim() ?? "";
  if (!targetAllowlist.trim() && !configuredMode) return baseGeneratePlaylists(opts);

  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : null;
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";
  const requestedMode = configuredMode || "SHADOW";

  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist,
    currentDestinationEpisodeIdsByTargetId:
      opts.currentDestinationEpisodeIdsByTargetId,
    requestedMode,
    simulate,
    trigger: opts.trigger,
    userId: opts.userId,
    targetScope,
    activeAllowlist: process.env.PODCAST_09_ACTIVE_ALLOWLIST ?? null,
    realActiveAllowlist: process.env.PODCAST_09_REAL_ACTIVE_ALLOWLIST ?? null,
  });

  const result = await runWithPodcast09ShadowRuntimeState(state, () =>
    baseGeneratePlaylists(opts),
  );

  // Best-effort observability only. A successful real Spotify write must never
  // become retryable because PODCAST-09 summary persistence failed afterwards.
  try {
    const row = await prisma.generationRun.findUnique({
      where: { id: result.runId },
      select: { summary: true },
    });
    const current =
      row?.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
        ? (row.summary as Prisma.JsonObject)
        : {};
    const evidence = JSON.parse(
      JSON.stringify(podcast09ShadowRuntimeSummary(state)),
    ) as Prisma.InputJsonValue;
    await prisma.generationRun.update({
      where: { id: result.runId },
      data: {
        summary: {
          ...current,
          podcast09ContinuationShadow: evidence,
        } as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PODCAST-09 Gate 5 runtime metrics persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // Best-effort diagnostic only.
    }
  }

  return result;
}
