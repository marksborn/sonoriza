import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { persistPlaybackReserveRolesAfterGeneration } from "@/services/playback-reserve-gate7";
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
 * PLAYBACK-RESERVE-01 Gate 7 outer generation seam.
 *
 * SHADOW preserves the previous behavior. Controlled ACTIVE may append RESERVE
 * to the physical plan only after the runtime guards authorize a single
 * allowlisted REBUILD_DAILY target. A real ACTIVE run also requires a previous
 * successful ACTIVE simulation for the same effective reserve policy.
 *
 * Explicit RESERVE roles are persisted immediately after GenerationItem rows.
 * Failure here never changes the canonical generation result into a retry
 * trigger; it is recorded as FAILED and MUSIC-06/MUSIC-07 abstain from the run.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetPlaylistIds = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : undefined;
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";
  const state = await preparePlaybackReserveShadowRuntime({
    userId: opts.userId,
    targetPlaylistIds,
    simulate,
  });

  const result = await runWithPlaybackReserveShadowRuntimeState(
    state,
    () => baseGeneratePlaylists(opts),
  );

  if (state.effectiveMode === "ACTIVE" && result.status !== "FAILED") {
    try {
      state.reserveRoleCount = await persistPlaybackReserveRolesAfterGeneration({
        runId: result.runId,
        state,
      });
      state.rolePersistenceStatus = "PERSISTED";
    } catch (error) {
      state.rolePersistenceStatus = "FAILED";
      try {
        await prisma.generationLog.create({
          data: {
            runId: result.runId,
            level: "ERROR",
            message: `PLAYBACK-RESERVE Gate 7 role persistence failed after generation; behavioral consumers will abstain from this run: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        });
      } catch {
        // Best-effort diagnostic only; never create a post-write retry hazard.
      }
    }
  } else if (state.effectiveMode === "ACTIVE" && result.status === "FAILED") {
    state.rolePersistenceStatus = "FAILED";
  }

  try {
    await appendPlaybackReserveRuntimeSummary(result.runId, state);
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PLAYBACK-RESERVE Gate 7 runtime summary persistence failed after generation: ${
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

async function appendPlaybackReserveRuntimeSummary(
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

  const runtime = JSON.parse(
    JSON.stringify(playbackReserveShadowRuntimeSummary(state)),
  ) as Prisma.InputJsonValue;

  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        playbackReserveRuntime: runtime,
        // Preserve the old diagnostic key while Gate 7 rolls out so existing
        // observability consumers do not lose the shadow projection abruptly.
        playbackReserveShadow: state.evidence
          ? (JSON.parse(JSON.stringify(state.evidence)) as Prisma.InputJsonValue)
          : null,
      } as Prisma.InputJsonValue,
    },
  });
}
