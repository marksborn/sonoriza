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
  /** PODCAST-09 Gate 3.1: factual episode order already present in each target. */
  currentDestinationEpisodeIdsByTargetId?: Record<string, string[]>;
};
export type { GeneratePlaylistsResult } from "./generate-playlists-music-identity";

/**
 * PODCAST-09 Gate 3.1 outer shadow boundary.
 *
 * With no explicit target allowlist this is a strict delegation: no additional
 * shadow planner pass or summary write occurs. When allowlisted, current target
 * episode order must be supplied by an upstream factual target-state read; the
 * shadow never invents destination membership and performs no provider read of
 * its own. The authoritative generation result always comes from the existing
 * chain.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetAllowlist = process.env.PODCAST_09_SHADOW_TARGET_ALLOWLIST ?? "";
  if (!targetAllowlist.trim()) return baseGeneratePlaylists(opts);

  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist,
    currentDestinationEpisodeIdsByTargetId:
      opts.currentDestinationEpisodeIdsByTargetId,
  });

  const result = await runWithPodcast09ShadowRuntimeState(state, () =>
    baseGeneratePlaylists(opts),
  );

  // Best-effort observability only. A successful real Spotify write must never
  // become retryable because Gate 3.1 summary persistence failed afterwards.
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
          message: `PODCAST-09 Gate 3.1 shadow metrics persistence failed after generation: ${
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
