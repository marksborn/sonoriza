import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  processMemoryCheckpoint,
  type ProcessMemoryCheckpoint,
} from "@/services/process-memory";
import { persistPlaybackReserveRolesAfterGeneration } from "@/services/playback-reserve-gate7";
import { preparePlaybackReserveGate8KeepFilledInput } from "@/services/playback-reserve-gate8";
import {
  playbackReserveKeepFilledNeedsInlineSimulation,
  playbackReserveGate8SimulationEligible,
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
  runWithPlaybackReserveShadowRuntimeState,
  type PlaybackReserveShadowRuntimeState,
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
 * PLAYBACK-RESERVE-01 Gate 8 outer generation seam.
 *
 * REBUILD_DAILY keeps the Gate 7 controlled rollout. KEEP_FILLED first strips
 * the previous explicit RESERVE segment from the preserved PRIMARY prefix. When
 * ACTIVE is requested for an allowlisted KEEP_FILLED target, an exact ACTIVE
 * simulation is executed against the same prepared preservation + snapshot
 * immediately before the real run. The resulting approval key includes that
 * snapshot, so a simulation for playlist state A cannot authorize state B.
 *
 * The extra simulation may perform provider reads but never writes Spotify. Any
 * failed simulation, role-persistence failure or approval mismatch creates a
 * failed real GenerationRun without attempting the remote write.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetPlaylistIds = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : undefined;
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";

  const gate8Prepared = await preparePlaybackReserveGate8KeepFilledInput({
    userId: opts.userId,
    targetPlaylistIds,
    preservedByTargetId: opts.preservedByTargetId,
    keepFilledByTargetId: opts.keepFilledByTargetId,
    scheduledPolicyByTargetId: opts.scheduledPolicyByTargetId,
  });
  const effectiveOpts: GeneratePlaylistsOptions = {
    ...opts,
    preservedByTargetId: gate8Prepared.preservedByTargetId,
    keepFilledByTargetId: gate8Prepared.keepFilledByTargetId,
  };

  const prepareState = (isSimulation: boolean) =>
    preparePlaybackReserveShadowRuntime({
      userId: effectiveOpts.userId,
      targetPlaylistIds,
      simulate: isSimulation,
      scheduledPolicyByTargetId: effectiveOpts.scheduledPolicyByTargetId,
      keepFilledContextByTargetId: gate8Prepared.contextByTargetId,
    });

  let state = await prepareState(simulate);

  if (!simulate && playbackReserveKeepFilledNeedsInlineSimulation(state)) {
    const simulationState = await prepareState(true);
    if (simulationState.effectiveMode !== "ACTIVE") {
      return createBlockedRealRun(
        effectiveOpts,
        state,
        `PLAYBACK-RESERVE Gate 8 KEEP_FILLED preflight could not enter ACTIVE: ${
          simulationState.status ?? "UNKNOWN"
        }`,
      );
    }

    const memoryCheckpoints: ProcessMemoryCheckpoint[] = [
      ...(effectiveOpts.gate8PreparationMemoryCheckpoints ?? []),
      processMemoryCheckpoint("RESERVE_GATE8_BEFORE_SIMULATION"),
    ];
    const simulationResult = await runWithPlaybackReserveShadowRuntimeState(
      simulationState,
      () =>
        baseGeneratePlaylists({
          ...withoutScheduledLifecycleHooks(effectiveOpts),
          trigger: "SIMULATION",
          simulate: true,
        }),
    );
    memoryCheckpoints.push(processMemoryCheckpoint("RESERVE_GATE8_AFTER_SIMULATION_RUN"));
    await finalizePlaybackReserveRuntime(simulationResult, simulationState, () => {
      memoryCheckpoints.push(processMemoryCheckpoint("RESERVE_GATE8_AFTER_ROLE_PERSISTENCE"));
    });
    memoryCheckpoints.push(processMemoryCheckpoint("RESERVE_GATE8_AFTER_SUMMARY_PERSISTENCE"));

    state.inlineSimulationRunId = simulationResult.runId;
    state.inlineSimulationStatus = simulationResult.status;
    state.additionalProviderReads = true;

    // PARTIAL may only approve Gate 8 when the persisted simulation proves
    // that its sole degradation was safely excluded source-scoped HTTP 502/404
    // and all quality checks passed. Never infer approval from status alone.
    const partialRun = simulationResult.status === "PARTIAL"
      ? await prisma.generationRun.findUnique({
          where: { id: simulationResult.runId },
          select: { status: true, simulation: true, summary: true },
        })
      : null;
    const simulationEligible =
      simulationResult.status === "SUCCESS" ||
      (partialRun?.simulation === true &&
        partialRun.status === simulationResult.status &&
        playbackReserveGate8SimulationEligible(partialRun.status, partialRun.summary));

    if (
      !simulationEligible ||
      simulationState.rolePersistenceStatus !== "PERSISTED"
    ) {
      await persistGate8MemoryCheckpoints(simulationResult.runId, memoryCheckpoints);
      return createBlockedRealRun(
        effectiveOpts,
        state,
        `PLAYBACK-RESERVE Gate 8 KEEP_FILLED preflight failed: simulation=${simulationResult.status}, roles=${
          simulationState.rolePersistenceStatus ?? "UNKNOWN"
        }`,
      );
    }

    const approvedState = await prepareState(false);
    memoryCheckpoints.push(processMemoryCheckpoint("RESERVE_GATE8_AFTER_REAL_STATE_PREP"));
    approvedState.inlineSimulationRunId = simulationResult.runId;
    approvedState.inlineSimulationStatus = simulationResult.status;
    approvedState.additionalProviderReads = true;

    if (approvedState.effectiveMode !== "ACTIVE") {
      await persistGate8MemoryCheckpoints(simulationResult.runId, memoryCheckpoints);
      return createBlockedRealRun(
        effectiveOpts,
        approvedState,
        `PLAYBACK-RESERVE Gate 8 KEEP_FILLED preflight was not reusable: ${
          approvedState.status ?? "UNKNOWN"
        }`,
      );
    }
    state = approvedState;
    memoryCheckpoints.push(processMemoryCheckpoint("RESERVE_GATE8_BEFORE_REAL_RUN"));
    await persistGate8MemoryCheckpoints(simulationResult.runId, memoryCheckpoints);
  }

  const result = await runWithPlaybackReserveShadowRuntimeState(
    state,
    () => baseGeneratePlaylists(effectiveOpts),
  );
  await finalizePlaybackReserveRuntime(result, state);
  return result;
}

async function finalizePlaybackReserveRuntime(
  result: GeneratePlaylistsResult,
  state: PlaybackReserveShadowRuntimeState,
  onAfterRolePersistence?: () => void,
): Promise<void> {
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
            message: `PLAYBACK-RESERVE Gate ${state.gate} role persistence failed after generation; behavioral consumers will abstain from this run: ${
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

  onAfterRolePersistence?.();
  try {
    await appendPlaybackReserveRuntimeSummary(result.runId, state);
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PLAYBACK-RESERVE Gate ${state.gate} runtime summary persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // Best-effort observability only.
    }
  }
}

/**
 * #442 Gate 2: append only bounded, memory-only checkpoint data to the
 * internal simulation run. Never change Gate 8 authorization if telemetry fails.
 * No Spotify reads/writes, playlist metadata, source IDs or URL payloads.
 */
async function persistGate8MemoryCheckpoints(
  simulationRunId: string,
  checkpoints: readonly ProcessMemoryCheckpoint[],
): Promise<void> {
  try {
    await prisma.generationLog.createMany({
      data: checkpoints.map(({ checkpoint, observedAt, memory }) => ({
        runId: simulationRunId,
        level: "INFO" as const,
        message: `Checkpoint ${checkpoint}`,
        data: {
          checkpoint,
          observedAt,
          memory,
        } as Prisma.InputJsonValue,
      })),
    });
  } catch {
    // Best-effort instrumentation must never fail an otherwise safe generation.
  }
}

async function createBlockedRealRun(
  opts: GeneratePlaylistsOptions,
  state: PlaybackReserveShadowRuntimeState,
  reason: string,
): Promise<GeneratePlaylistsResult> {
  const run = await prisma.generationRun.create({
    data: {
      userId: opts.userId,
      trigger: opts.trigger,
      simulation: false,
      status: "FAILED",
      error: reason,
      summary: {
        simulate: false,
        targetScope: opts.targetPlaylistIds ?? null,
        qualityPassed: false,
        collectionComplete: false,
        inconclusive: true,
        playbackReserveRuntime: JSON.parse(
          JSON.stringify(playbackReserveShadowRuntimeSummary(state)),
        ) as Prisma.InputJsonValue,
      } as Prisma.InputJsonValue,
    },
  });

  try {
    await prisma.generationLog.create({
      data: {
        runId: run.id,
        level: "ERROR",
        message: reason,
      },
    });
  } catch {
    // The failed GenerationRun is already the authoritative no-write outcome.
  }

  return { runId: run.id, status: "FAILED" };
}

async function appendPlaybackReserveRuntimeSummary(
  runId: string,
  state: PlaybackReserveShadowRuntimeState,
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
        playbackReserveShadow: state.evidence
          ? (JSON.parse(JSON.stringify(state.evidence)) as Prisma.InputJsonValue)
          : null,
      } as Prisma.InputJsonValue,
    },
  });
}


/**
 * #435 Gate 3E
 *
 * Inline Playback Reserve simulations are implementation details of a real
 * scheduled run. They may inspect the same prepared state, but they do not own
 * the scheduler attempt and therefore must never inherit lifecycle callbacks
 * that link/fence the real GenerationRun.
 */
function withoutScheduledLifecycleHooks(
  opts: GeneratePlaylistsOptions,
): GeneratePlaylistsOptions {
  const simulationOpts = { ...opts };
  delete simulationOpts.onGenerationRunCreated;
  delete simulationOpts.assertGenerationRunStillActive;
  return simulationOpts;
}
