import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
  runWithPlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-podcast07";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-podcast07";

/**
 * PLAYBACK-RESERVE-01 Gate 3 outer generation seam.
 *
 * The existing generator remains authoritative. This wrapper only resolves the
 * effective reserve policy, exposes it to the read-only planner shadow and
 * appends diagnostics after the run. Failure to persist observability after a
 * successful real write never converts that write into a retry hazard.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetPlaylistIds = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : undefined;
  const state = await preparePlaybackReserveShadowRuntime({
    userId: opts.userId,
    targetPlaylistIds,
  });

  const result = await runWithPlaybackReserveShadowRuntimeState(
    state,
    () => baseGeneratePlaylists(opts),
  );

  try {
    await appendPlaybackReserveShadowSummary(result.runId, state);
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PLAYBACK-RESERVE Gate 3 shadow persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // Best-effort observability only.
    }
  }

  return result;
}

async function appendPlaybackReserveShadowSummary(
  runId: string,
  state: Awaited<ReturnType<typeof preparePlaybackReserveShadowRuntime>>,
): Promise<void> {
  const row = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  const current =
    row?.summary && typeof row.summary === "object" && !Array.isArray(row.summary)
      ? (row.summary as Prisma.JsonObject)
      : {};

  const evidence = JSON.parse(
    JSON.stringify(playbackReserveShadowRuntimeSummary(state)),
  ) as Prisma.InputJsonValue;

  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        playbackReserveShadow: evidence,
      } as Prisma.InputJsonValue,
    },
  });
}
