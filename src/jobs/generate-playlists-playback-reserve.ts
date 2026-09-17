import type { Prisma, RunStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { assessCalendar03GenerationConfiguration } from "@/services/calendar-event-composition-generation";
import { assessConfiguration } from "@/services/configuration-readiness";
import {
  findReusablePlaybackReserveSimulationEvidence,
  playbackReserveGate7ProjectionFingerprint,
  playbackReserveGate7RuntimeFromEnvironment,
  playbackReserveGate7TargetIsActive,
  type PlaybackReserveGate7SimulationEvidence,
} from "@/services/playback-reserve-gate7";
import {
  playbackReserveShadowRuntimeSummary,
  preparePlaybackReserveShadowRuntime,
  runWithPlaybackReserveShadowRuntimeState,
} from "@/services/playback-reserve-shadow-runtime";
import type { PlaybackReserveTargetShadowEvidence } from "@/services/playlist-planner/plan-run-playback-reserve";
import type { PlaybackReserveShadowSelectedItem } from "@/services/playlist-planner/playback-reserve-duration-shadow";
import {
  checkPodcastCompletionBeforeWrite,
} from "@/services/spotify/podcast-authoritative-state";
import { SpotifyClient } from "@/services/spotify";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-podcast07";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-podcast07";

type Gate7TargetResult = Record<string, unknown> & {
  targetPlaylistId: string;
  status: string;
};

/**
 * PLAYBACK-RESERVE-01 Gate 7 outer generation seam.
 *
 * PRIMARY remains fully owned by the established generator. The reserve planner
 * still runs as the validated shadow projection, but ACTIVE may append its exact
 * suffix only for target IDs explicitly allowlisted in the environment, only on
 * full-generation/REBUILD_DAILY paths, and only after a current quality-approved
 * simulation with the same configuration fingerprint exists.
 *
 * KEEP_FILLED remains untouched until Gate 8. A changed projection, snapshot or
 * factual podcast state never falls through to a permissive reserve write.
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
  const gate7Runtime = playbackReserveGate7RuntimeFromEnvironment();
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";
  const activeTargetIds = [...state.policies.entries()]
    .filter(
      ([targetPlaylistId, policy]) =>
        policy.reserveMode !== "NONE" &&
        playbackReserveGate7TargetIsActive(gate7Runtime, targetPlaylistId) &&
        !isKeepFilledGate8Path(opts, targetPlaylistId),
    )
    .map(([targetPlaylistId]) => targetPlaylistId);

  let configurationFingerprint: string | null = null;
  let approvedSimulationEvidence = new Map<
    string,
    PlaybackReserveGate7SimulationEvidence
  >();

  if (!simulate && activeTargetIds.length > 0) {
    const baseAssessment = await assessConfiguration(opts.userId);
    const calendar03 = await assessCalendar03GenerationConfiguration(
      opts.userId,
      baseAssessment,
    );
    configurationFingerprint = calendar03.assessment.fingerprint;
    approvedSimulationEvidence = new Map(
      await findReusablePlaybackReserveSimulationEvidence(
        opts.userId,
        configurationFingerprint,
        activeTargetIds,
      ),
    );

    const missingSimulationTargets = activeTargetIds.filter(
      (targetId) => !approvedSimulationEvidence.has(targetId),
    );
    if (missingSimulationTargets.length > 0) {
      return recordGate7PrewriteBlock({
        opts,
        configurationFingerprint,
        gate7Runtime,
        activeTargetIds,
        missingSimulationTargets,
      });
    }
  }

  const result = await runWithPlaybackReserveShadowRuntimeState(
    state,
    () => baseGeneratePlaylists(opts),
  );

  const shadow = playbackReserveShadowRuntimeSummary(state);
  let finalStatus: RunStatus = result.status;
  let gate7TargetResults: Gate7TargetResult[] = [];

  if (simulate) {
    gate7TargetResults = shadow.targets.map((target) =>
      simulationTargetSummary(target, gate7Runtime, opts),
    );
  } else if (result.status !== "FAILED" && activeTargetIds.length > 0) {
    const applied = await applyGate7ReserveAfterPrimary({
      opts,
      runId: result.runId,
      activeTargetIds,
      approvedSimulationEvidence,
      shadowTargets: shadow.targets,
    });
    gate7TargetResults = applied.targets;
    if (applied.hadFailure && finalStatus === "SUCCESS") {
      finalStatus = "PARTIAL";
      await prisma.generationRun.update({
        where: { id: result.runId },
        data: { status: "PARTIAL" },
      });
    }
  } else {
    gate7TargetResults = shadow.targets.map((target) =>
      inactiveTargetSummary(target, gate7Runtime, opts),
    );
  }

  try {
    await appendPlaybackReserveSummary(result.runId, state, {
      gate: 7,
      requestedMode: gate7Runtime.requestedMode,
      effectiveMode: gate7Runtime.effectiveMode,
      status: gate7Runtime.status,
      activeTargetIds: [...gate7Runtime.activeTargetIds].sort(),
      configurationFingerprint,
      simulation: simulate,
      productiveWriteAttempted:
        !simulate && activeTargetIds.length > 0 && result.status !== "FAILED",
      productiveTargetCount: gate7TargetResults.filter(
        (target) => target.status === "APPLIED" || target.status === "APPLIED_NO_ITEMS",
      ).length,
      targets: gate7TargetResults,
    });
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PLAYBACK-RESERVE Gate 7 summary persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // The productive audit also exists in GenerationItem/GenerationPlanItemRole.
    }
  }

  return { ...result, status: finalStatus };
}

async function applyGate7ReserveAfterPrimary(input: {
  opts: GeneratePlaylistsOptions;
  runId: string;
  activeTargetIds: readonly string[];
  approvedSimulationEvidence: ReadonlyMap<
    string,
    PlaybackReserveGate7SimulationEvidence
  >;
  shadowTargets: readonly PlaybackReserveTargetShadowEvidence[];
}): Promise<{ targets: Gate7TargetResult[]; hadFailure: boolean }> {
  const run = await prisma.generationRun.findUnique({
    where: { id: input.runId },
    select: { summary: true },
  });
  const summary = objectValue(run?.summary) ?? {};
  const targetSummaryById = new Map(
    (Array.isArray(summary.targets) ? summary.targets : []).flatMap((raw) => {
      const target = objectValue(raw);
      const id = stringValue(target?.targetPlaylistId);
      return id && target ? [[id, target] as const] : [];
    }),
  );
  const shadowById = new Map(
    input.shadowTargets.map((target) => [target.targetPlaylistId, target] as const),
  );
  const targets = await prisma.targetPlaylist.findMany({
    where: { id: { in: [...input.activeTargetIds] }, userId: input.opts.userId },
    select: { id: true, name: true, spotifyPlaylistId: true },
  });
  const targetById = new Map(targets.map((target) => [target.id, target] as const));
  const results: Gate7TargetResult[] = [];
  let writer: SpotifyClient | null = null;
  let hadFailure = false;

  for (const targetPlaylistId of input.activeTargetIds) {
    const target = targetById.get(targetPlaylistId);
    const targetSummary = targetSummaryById.get(targetPlaylistId);
    const shadow = shadowById.get(targetPlaylistId);
    const approved = input.approvedSimulationEvidence.get(targetPlaylistId);

    if (!target || !target.spotifyPlaylistId || !targetSummary || !shadow || !approved) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        status: "ABSTAIN_MISSING_RUNTIME_EVIDENCE",
      });
      continue;
    }
    if (targetSummary.applied !== true) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_PRIMARY_NOT_APPLIED",
      });
      continue;
    }
    if (!shadow.reserve || !shadow.policy || shadow.policy.reserveMode === "NONE") {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_RESERVE_PROJECTION_MISSING",
      });
      continue;
    }

    const actualProjectionFingerprint =
      playbackReserveGate7ProjectionFingerprint(shadow);
    if (
      !actualProjectionFingerprint ||
      actualProjectionFingerprint !== approved.projectionFingerprint
    ) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_SIMULATION_PROJECTION_CHANGED",
        approvedSimulationRunId: approved.simulationRunId,
        approvedProjectionFingerprint: approved.projectionFingerprint,
        actualProjectionFingerprint,
      });
      continue;
    }

    const primaryItems = await prisma.generationItem.findMany({
      where: { runId: input.runId, targetPlaylistId },
      orderBy: { position: "asc" },
      select: { position: true, spotifyUri: true },
    });
    const primaryPositionsValid = primaryItems.every(
      (item, index) => item.position === index,
    );
    const primaryUris = new Set(primaryItems.map((item) => item.spotifyUri));
    const selectedItems = shadow.reserve.selectedItems;
    const duplicateWithPrimary = selectedItems.find((item) => primaryUris.has(item.uri));
    if (
      !primaryPositionsValid ||
      primaryItems.length !== shadow.primary.itemCount ||
      duplicateWithPrimary
    ) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_PRIMARY_RESERVE_BOUNDARY_CHANGED",
        primaryItemCount: primaryItems.length,
        projectedPrimaryItemCount: shadow.primary.itemCount,
        duplicateUri: duplicateWithPrimary?.uri ?? null,
      });
      continue;
    }

    writer ??= await SpotifyClient.forUser(input.opts.userId);
    const expectedPrimarySnapshot = stringValue(targetSummary.snapshotAfter);
    const currentSnapshot = await writer.getPlaylistSnapshotId(target.spotifyPlaylistId);
    if (!expectedPrimarySnapshot || currentSnapshot !== expectedPrimarySnapshot) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_TARGET_SNAPSHOT_CHANGED",
        expectedSnapshot: expectedPrimarySnapshot,
        actualSnapshot: currentSnapshot,
      });
      continue;
    }

    const externalSnapshotChanges = await changedExternalReservationSnapshots(
      writer,
      input.opts.reservedTargetSnapshots ?? {},
    );
    if (externalSnapshotChanges.length > 0) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_EXTERNAL_RESERVATION_CHANGED",
        externalSnapshotChanges,
      });
      continue;
    }

    const reserveCandidates = selectedItems.map(toCandidateForPrewrite);
    try {
      const podcastPrewrite = await checkPodcastCompletionBeforeWrite(
        input.opts.userId,
        [
          {
            targetPlaylistId,
            targetName: target.name,
            items: reserveCandidates,
          },
        ],
        new Date(),
        { episodeReader: (episodeId) => writer!.getEpisodePlaybackState(episodeId) },
      );
      if (podcastPrewrite.violations.length > 0) {
        hadFailure = true;
        results.push({
          targetPlaylistId,
          targetName: target.name,
          status: "ABSTAIN_PODCAST_PREWRITE_CHANGED",
          checkedEpisodeIds: podcastPrewrite.checkedEpisodeIds,
          violations: podcastPrewrite.violations,
        });
        continue;
      }
    } catch (error) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "ABSTAIN_PODCAST_PREWRITE_UNAVAILABLE",
        error: errorMessage(error),
      });
      continue;
    }

    let finalSnapshot = currentSnapshot;
    const reserveUris = selectedItems.map((item) => item.uri);
    try {
      if (reserveUris.length > 0) {
        finalSnapshot =
          (await writer.appendPlaylistItems(target.spotifyPlaylistId, reserveUris)) ??
          currentSnapshot;
      }
      await persistGate7PublishedItems({
        runId: input.runId,
        targetPlaylistId,
        primaryItemCount: primaryItems.length,
        selectedItems,
        policy: shadow.policy,
      });

      const reserveDurationMs = selectedItems.reduce(
        (sum, item) => sum + Math.max(0, item.durationMs),
        0,
      );
      const reserveMusicCount = selectedItems.filter(
        (item) => item.type === "MUSIC",
      ).length;
      const reservePodcastCount = selectedItems.length - reserveMusicCount;
      const primarySnapshotAfter = currentSnapshot;

      targetSummary.snapshotAfter = finalSnapshot;
      targetSummary.publishedCount = primaryItems.length + selectedItems.length;
      targetSummary.totalPublishedDurationMs =
        numberValue(targetSummary.totalDurationMs, 0) + reserveDurationMs;
      targetSummary.playbackReserveGate7 = {
        gate: 7,
        mode: "ACTIVE",
        status: reserveUris.length > 0 ? "APPLIED" : "APPLIED_NO_ITEMS",
        approvedSimulationRunId: approved.simulationRunId,
        projectionFingerprint: actualProjectionFingerprint,
        policy: shadow.policy,
        primaryItemCount: primaryItems.length,
        primarySnapshotAfter,
        reserveStartsAtPosition: primaryItems.length,
        reserveItemCount: selectedItems.length,
        reserveMusicCount,
        reservePodcastCount,
        reserveDurationMs,
        reserveShortfall: shadow.status === "SHORTFALL",
        snapshotAfter: finalSnapshot,
      };

      if (typeof targetSummary.addedCount === "number") {
        targetSummary.addedCount += selectedItems.length;
      }
      if (typeof targetSummary.addedDurationMs === "number") {
        targetSummary.addedDurationMs += reserveDurationMs;
      }
      if (typeof targetSummary.addedMusicCount === "number") {
        targetSummary.addedMusicCount += reserveMusicCount;
      }
      if (typeof targetSummary.addedPodcastCount === "number") {
        targetSummary.addedPodcastCount += reservePodcastCount;
      }
      if (typeof targetSummary.addedMusicDurationMs === "number") {
        targetSummary.addedMusicDurationMs += selectedItems
          .filter((item) => item.type === "MUSIC")
          .reduce((sum, item) => sum + item.durationMs, 0);
      }
      if (typeof targetSummary.addedPodcastDurationMs === "number") {
        targetSummary.addedPodcastDurationMs += selectedItems
          .filter((item) => item.type === "PODCAST")
          .reduce((sum, item) => sum + item.durationMs, 0);
      }

      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: reserveUris.length > 0 ? "APPLIED" : "APPLIED_NO_ITEMS",
        approvedSimulationRunId: approved.simulationRunId,
        projectionFingerprint: actualProjectionFingerprint,
        reserveItemCount: selectedItems.length,
        reserveDurationMs,
        reserveShortfall: shadow.status === "SHORTFALL",
        snapshotAfter: finalSnapshot,
      });
    } catch (error) {
      hadFailure = true;
      results.push({
        targetPlaylistId,
        targetName: target.name,
        status: "PARTIAL_RESERVE_APPLY_FAILED",
        error: errorMessage(error),
      });
    }
  }

  try {
    await prisma.generationRun.update({
      where: { id: input.runId },
      data: {
        summary: {
          ...summary,
          targets: Array.from(targetSummaryById.values()),
        } as Prisma.InputJsonValue,
      },
    });
  } catch {
    hadFailure = true;
  }

  return { targets: results, hadFailure };
}

async function persistGate7PublishedItems(input: {
  runId: string;
  targetPlaylistId: string;
  primaryItemCount: number;
  selectedItems: readonly PlaybackReserveShadowSelectedItem[];
  policy: NonNullable<PlaybackReserveTargetShadowEvidence["policy"]>;
}): Promise<void> {
  const reservePolicy = {
    targetPlaylistId: input.policy.targetPlaylistId,
    source: input.policy.source,
    reserveMode: input.policy.reserveMode,
    durationSeconds: input.policy.durationSeconds,
    musicTrackCount: input.policy.musicTrackCount,
    podcastEpisodeCount: input.policy.podcastEpisodeCount,
    podcastInDurationReserve: input.policy.podcastInDurationReserve,
  } satisfies Prisma.InputJsonObject;

  await prisma.$transaction(async (tx) => {
    if (input.selectedItems.length > 0) {
      await tx.generationItem.createMany({
        data: input.selectedItems.map((item, index) => ({
          runId: input.runId,
          targetPlaylistId: input.targetPlaylistId,
          position: input.primaryItemCount + index,
          contentType: item.type,
          spotifyUri: item.uri,
          title: item.title,
          subtitle: item.subtitle,
          programId: item.programId,
          durationMs: item.durationMs,
          spotifyTrackId: item.spotifyTrackId,
          primaryArtistId: item.primaryArtistId,
          albumId: item.albumId,
          originalDurationMs: item.originalDurationMs,
          resumePositionMs: item.resumePositionMs,
          sourceSpotifyType: item.sourceSpotifyType,
          sourceSpotifyId: item.sourceSpotifyId,
          sourceIncludePlayed: item.sourceIncludePlayed,
        })),
      });
    }

    await tx.generationPlanItemRole.createMany({
      data: [
        ...Array.from({ length: input.primaryItemCount }, (_, position) => ({
          runId: input.runId,
          targetPlaylistId: input.targetPlaylistId,
          position,
          role: "PRIMARY" as const,
          reservePolicy: Prisma.DbNull,
        })),
        ...input.selectedItems.map((_, index) => ({
          runId: input.runId,
          targetPlaylistId: input.targetPlaylistId,
          position: input.primaryItemCount + index,
          role: "RESERVE" as const,
          reservePolicy,
        })),
      ],
      skipDuplicates: true,
    });
  });
}

async function changedExternalReservationSnapshots(
  writer: SpotifyClient,
  snapshots: Readonly<Record<string, string>>,
) {
  const changes: Array<{ spotifyPlaylistId: string; expected: string; actual: string }> = [];
  for (const [spotifyPlaylistId, expected] of Object.entries(snapshots)) {
    const actual = await writer.getPlaylistSnapshotId(spotifyPlaylistId);
    if (actual !== expected) changes.push({ spotifyPlaylistId, expected, actual });
  }
  return changes;
}

function simulationTargetSummary(
  target: PlaybackReserveTargetShadowEvidence,
  runtime: ReturnType<typeof playbackReserveGate7RuntimeFromEnvironment>,
  opts: GeneratePlaylistsOptions,
): Gate7TargetResult {
  const policyEnabled = target.policy?.reserveMode !== "NONE" && target.reserve !== null;
  const allowlisted = playbackReserveGate7TargetIsActive(runtime, target.targetPlaylistId);
  const keepFilled = isKeepFilledGate8Path(opts, target.targetPlaylistId);
  return {
    targetPlaylistId: target.targetPlaylistId,
    targetName: target.targetName,
    status:
      runtime.effectiveMode !== "ACTIVE"
        ? "SHADOW_ONLY"
        : !allowlisted
          ? "SHADOW_ONLY_TARGET_NOT_ALLOWLISTED"
          : keepFilled
            ? "DEFERRED_KEEP_FILLED_GATE8"
            : !policyEnabled
              ? "DISABLED_NONE"
              : "SIMULATION_PREVIEW_READY",
    projectionFingerprint: policyEnabled
      ? playbackReserveGate7ProjectionFingerprint(target)
      : null,
  };
}

function inactiveTargetSummary(
  target: PlaybackReserveTargetShadowEvidence,
  runtime: ReturnType<typeof playbackReserveGate7RuntimeFromEnvironment>,
  opts: GeneratePlaylistsOptions,
): Gate7TargetResult {
  return simulationTargetSummary(target, runtime, opts);
}

function isKeepFilledGate8Path(
  opts: GeneratePlaylistsOptions,
  targetPlaylistId: string,
): boolean {
  return (
    Boolean(opts.keepFilledByTargetId?.[targetPlaylistId]) ||
    opts.scheduledPolicyByTargetId?.[targetPlaylistId] === "KEEP_FILLED"
  );
}

async function recordGate7PrewriteBlock(input: {
  opts: GeneratePlaylistsOptions;
  configurationFingerprint: string;
  gate7Runtime: ReturnType<typeof playbackReserveGate7RuntimeFromEnvironment>;
  activeTargetIds: readonly string[];
  missingSimulationTargets: readonly string[];
}): Promise<GeneratePlaylistsResult> {
  const message =
    "PLAYBACK-RESERVE Gate 7 bloqueou a geração antes do Spotify: execute uma simulação atual e aprovada para os destinos produtivos de reserva.";
  const run = await prisma.generationRun.create({
    data: {
      userId: input.opts.userId,
      trigger: input.opts.trigger,
      simulation: false,
      status: "FAILED",
      finishedAt: new Date(),
      error: message,
      summary: {
        simulate: false,
        qualityPassed: false,
        collectionComplete: false,
        inconclusive: true,
        inconclusiveReason: "PLAYBACK_RESERVE_SIMULATION_REQUIRED",
        configurationFingerprint: input.configurationFingerprint,
        targets: [],
        playbackReserveGate7: {
          gate: 7,
          requestedMode: input.gate7Runtime.requestedMode,
          effectiveMode: input.gate7Runtime.effectiveMode,
          status: "BLOCKED_SIMULATION_REQUIRED",
          activeTargetIds: input.activeTargetIds,
          missingSimulationTargetIds: input.missingSimulationTargets,
          productiveWriteAttempted: false,
        },
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.generationLog.create({
    data: {
      runId: run.id,
      level: "WARN",
      message,
      data: {
        missingSimulationTargetIds: input.missingSimulationTargets,
      } as Prisma.InputJsonValue,
    },
  });
  return { runId: run.id, status: "FAILED" };
}

async function appendPlaybackReserveSummary(
  runId: string,
  state: Awaited<ReturnType<typeof preparePlaybackReserveShadowRuntime>>,
  gate7: Record<string, unknown>,
): Promise<void> {
  const row = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  const current = objectValue(row?.summary) ?? {};
  const evidence = JSON.parse(
    JSON.stringify(playbackReserveShadowRuntimeSummary(state)),
  ) as Prisma.InputJsonValue;

  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        playbackReserveShadow: evidence,
        playbackReserveGate7: gate7,
      } as Prisma.InputJsonValue,
    },
  });
}

function toCandidateForPrewrite(item: PlaybackReserveShadowSelectedItem) {
  return {
    uri: item.uri,
    type: item.type,
    title: item.title ?? item.uri,
    subtitle: item.subtitle ?? undefined,
    spotifyTrackId: item.spotifyTrackId ?? undefined,
    primaryArtistId: item.primaryArtistId ?? undefined,
    albumId: item.albumId ?? undefined,
    programId: item.programId ?? undefined,
    durationMs: item.durationMs,
    originalDurationMs: item.originalDurationMs ?? undefined,
    resumePositionMs: item.resumePositionMs ?? undefined,
    sourceSpotifyType: item.sourceSpotifyType ?? undefined,
    sourceSpotifyId: item.sourceSpotifyId ?? undefined,
    sourcePlaylistId: item.sourcePlaylistId ?? undefined,
    sourceIncludePlayed: item.sourceIncludePlayed ?? undefined,
    spotifyEpisodeId: item.spotifyEpisodeId ?? undefined,
  };
}

function objectValue(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
