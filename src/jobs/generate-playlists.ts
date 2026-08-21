import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { isSpotifyApiError } from "@/services/spotify";
import { refreshMusicRepeatContext } from "@/services/spotify/recently-played";

import {
  createDiscoveryGate4ARunState,
  discoveryRuntimeSummary,
  runWithDiscoveryRuntimeState,
  type DiscoveryRuntimeState,
} from "./discovery-runtime";
import {
  runWithMusicRepeatState,
  type MusicRepeatRunState,
} from "./music-repeat-runtime";
import {
  generatePlaylists as generatePlaylistsIncremental,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-incremental";

export type { GeneratePlaylistsOptions, GeneratePlaylistsResult };

/**
 * MUSIC-01 wrapper around the existing generator. Gate 4A also establishes a
 * fail-closed DISCOVERY runtime context, disabled by default and enabled only
 * when both the master flag and the per-user e-mail allowlist match.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";
  const asOf = opts.date ?? new Date();
  let prepared: Awaited<ReturnType<typeof refreshMusicRepeatContext>>;

  try {
    prepared = await refreshMusicRepeatContext(opts.userId, new Date());
  } catch (error) {
    return recordPlaybackHistorySyncFailure(opts, simulate, error);
  }

  const user = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: { email: true },
  });
  const discoveryState = createDiscoveryGate4ARunState({
    userId: opts.userId,
    userEmail: user?.email ?? null,
    asOf,
  });

  const state: MusicRepeatRunState = {
    userId: opts.userId,
    simulate,
    context: prepared.context,
    initialSync: prepared.sync,
    recentlyPlayedSkippedCount: 0,
    missingTrackIdentitySkippedCount: 0,
    preWriteSync: null,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    preWriteMissingIdentityCount: 0,
  };

  const result = await runWithMusicRepeatState(state, () =>
    runWithDiscoveryRuntimeState(discoveryState, () =>
      generatePlaylistsIncremental(opts),
    ),
  );

  // The underlying generator is authoritative for the execution result. If the
  // auxiliary observability cannot be appended afterwards, never turn a
  // successfully completed real write into an API-level failure/retry hazard.
  try {
    await appendRuntimeSummary(result.runId, state, discoveryState);
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `Runtime metrics persistence failed after generation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      });
    } catch {
      // Best-effort observability must not change generation semantics.
    }
  }

  return result;
}

async function appendRuntimeSummary(
  runId: string,
  state: MusicRepeatRunState,
  discoveryState: DiscoveryRuntimeState,
): Promise<void> {
  const run = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  const current =
    run?.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
      ? (run.summary as Record<string, unknown>)
      : {};

  const musicRepeat = musicRepeatSummary(state);
  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        musicRepeat,
        musicRecentlyPlayedSkippedCount: state.recentlyPlayedSkippedCount,
        musicMissingTrackIdentitySkippedCount:
          state.missingTrackIdentitySkippedCount,
        discoveryRuntime: discoveryRuntimeSummary(discoveryState),
      } as Prisma.InputJsonValue,
    },
  });
}

async function recordPlaybackHistorySyncFailure(
  opts: GeneratePlaylistsOptions,
  simulate: boolean,
  error: unknown,
): Promise<GeneratePlaylistsResult> {
  const message = error instanceof Error ? error.message : String(error);
  const spotifyError = isSpotifyApiError(error) ? error : null;
  const now = new Date();
  const run = await prisma.generationRun.create({
    data: {
      userId: opts.userId,
      trigger: opts.trigger,
      simulation: simulate,
      status: "FAILED",
      finishedAt: now,
      error: message,
      summary: {
        simulate,
        targets: [],
        qualityPassed: false,
        collectionComplete: false,
        inconclusive: true,
        inconclusiveReason: "MUSIC_RECENT_HISTORY_UNAVAILABLE",
        musicRepeat: {
          enabled: true,
          syncFailed: true,
          errorKind: spotifyError?.kind ?? "HISTORY_SYNC_FAILED",
          status: spotifyError?.status ?? null,
          retryAfterSeconds: spotifyError?.retryAfterSeconds ?? null,
        },
      } as Prisma.InputJsonValue,
    },
  });
  await prisma.generationLog.create({
    data: {
      runId: run.id,
      level: "WARN",
      message: `MUSIC-01 playback history synchronization failed: ${message}`,
    },
  });
  return { runId: run.id, status: "FAILED" };
}

function musicRepeatSummary(state: MusicRepeatRunState): Record<string, unknown> {
  const context = state.context;
  return {
    enabled: context.enabled,
    windowValue: context.windowValue,
    windowUnit: context.windowUnit,
    cutoff: context.cutoff?.toISOString() ?? null,
    historyKnownSince: context.historyKnownSince?.toISOString() ?? null,
    lastSyncAt: context.lastSyncAt?.toISOString() ?? null,
    blockedTrackCount: context.blockedTrackIds.size,
    recentlyPlayedSkippedCount: state.recentlyPlayedSkippedCount,
    missingTrackIdentitySkippedCount: state.missingTrackIdentitySkippedCount,
    initialSync: {
      eventsRead: state.initialSync.eventsRead,
      identitiesUpdated: state.initialSync.identitiesUpdated,
      listeningEventsInserted: state.initialSync.listeningEventsInserted,
      listeningEventsDuplicateCount:
        state.initialSync.listeningEventsDuplicateCount,
      listeningEventsSuppressedByHandoff:
        state.initialSync.listeningEventsSuppressedByHandoff,
      lastSyncAt: state.initialSync.lastSyncAt?.toISOString() ?? null,
    },
    preWriteRevalidated: state.preWriteRevalidated,
    preWriteBlockedCount: state.preWriteBlockedCount,
    preWriteMissingIdentityCount: state.preWriteMissingIdentityCount,
    preWriteSync: state.preWriteSync
      ? {
          eventsRead: state.preWriteSync.eventsRead,
          identitiesUpdated: state.preWriteSync.identitiesUpdated,
          listeningEventsInserted: state.preWriteSync.listeningEventsInserted,
          listeningEventsDuplicateCount:
            state.preWriteSync.listeningEventsDuplicateCount,
          listeningEventsSuppressedByHandoff:
            state.preWriteSync.listeningEventsSuppressedByHandoff,
          lastSyncAt: state.preWriteSync.lastSyncAt?.toISOString() ?? null,
        }
      : null,
  };
}
