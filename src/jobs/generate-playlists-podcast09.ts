import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  createPodcast09ShadowRuntimeState,
  podcast09ShadowRuntimeSummary,
  runWithPodcast09ShadowRuntimeState,
} from "@/services/playlist-planner/podcast-continuation-shadow-runtime";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-music-identity";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-music-identity";

/**
 * PODCAST-09 Gate 3 outer shadow boundary.
 *
 * With no explicit target allowlist this is a strict delegation: no additional
 * DB read, planner shadow pass or summary write occurs. When allowlisted, the
 * wrapper reads only already-persisted EpisodeListeningState timestamps and
 * exposes them to the in-memory shadow planner. The authoritative generation
 * result always comes from the existing chain.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetAllowlist = process.env.PODCAST_09_SHADOW_TARGET_ALLOWLIST ?? "";
  if (!targetAllowlist.trim()) return baseGeneratePlaylists(opts);

  const listeningStates = await prisma.episodeListeningState.findMany({
    where: { userId: opts.userId },
    select: {
      spotifyEpisodeId: true,
      status: true,
      lastObservedAt: true,
      firstProgressObservedAt: true,
    },
  });
  const state = createPodcast09ShadowRuntimeState({
    targetAllowlist,
    listeningStates: listeningStates.map((entry) => ({
      spotifyEpisodeId: entry.spotifyEpisodeId,
      status: entry.status,
      lastObservedAt: entry.lastObservedAt,
      firstProgressObservedAt: entry.firstProgressObservedAt,
    })),
  });

  const result = await runWithPodcast09ShadowRuntimeState(state, () =>
    baseGeneratePlaylists(opts),
  );

  // Best-effort observability only. A successful real Spotify write must never
  // become retryable because Gate 3 summary persistence failed afterwards.
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
          message: `PODCAST-09 Gate 3 shadow metrics persistence failed after generation: ${
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
