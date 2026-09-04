import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { spotifyRecentlyPlayedPlannerCapability } from "@/services/data-policy";
import {
  createMusic06PlannerRuntimeState,
  music06PlannerRuntimeSummary,
  prepareMusic06PlannerRuntime,
  prismaFirstPartyPlaybackPreferenceStore,
  runWithMusic06PlannerRuntimeState,
  type Music06PlannerRuntimeState,
} from "@/services/music-preference";
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
import {
  createTargetDiscoveryRuntimeState,
  runWithTargetDiscoveryRuntimeState,
  targetDiscoveryRuntimeSummary,
  type TargetDiscoveryRuntimeState,
} from "./target-discovery-runtime";

export type { GeneratePlaylistsOptions, GeneratePlaylistsResult };

/**
 * Generation wrapper with central policy/runtime contexts.
 *
 * MUSIC-06 Gate 5B prepares Last.fm + first-party published-order evidence only
 * when the scoped personal capability, feature flag and user allowlist all
 * permit it. Provider failure/incomplete coverage abstains and generation
 * continues unchanged. The runtime can only perform a bounded MUSIC rerank;
 * it never changes eligibility or candidate cardinality.
 *
 * Gate 5B also loads explicit first-party preferences. Gate 5C puts MUSIC-01's
 * Spotify Recently Played cooldown behind the central capability matrix. Under
 * the current policy, generation does not sync/read Recently Played for planner
 * eligibility and that provider history cannot veto a plan.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const simulate = opts.simulate ?? opts.trigger === "SIMULATION";
  const asOf = opts.date ?? new Date();
  const repeatCompliance = spotifyRecentlyPlayedPlannerCapability();
  let prepared: Awaited<ReturnType<typeof refreshMusicRepeatContext>>;

  if (repeatCompliance.allowed) {
    try {
      prepared = await refreshMusicRepeatContext(opts.userId, new Date());
    } catch (error) {
      return recordPlaybackHistorySyncFailure(opts, simulate, error);
    }
  } else {
    prepared = quarantinedMusicRepeatPreparation();
  }

  const [user, firstPartyPlaybackPreferences] = await Promise.all([
    prisma.user.findUnique({
      where: { id: opts.userId },
      select: { email: true },
    }),
    prismaFirstPartyPlaybackPreferenceStore.list(opts.userId),
  ]);

  // MUSIC-06 evidence is behavioral observation at execution time, not the
  // calendar planning date supplied through opts.date.
  const music06Preparation = await prepareMusic06PlannerRuntime({
    userId: opts.userId,
    userEmail: user?.email ?? null,
    asOf: new Date(),
  });
  const music06State = createMusic06PlannerRuntimeState({
    preparation: music06Preparation,
    firstPartyPreferences: firstPartyPlaybackPreferences,
  });

  const discoveryState = createDiscoveryGate4ARunState({
    userId: opts.userId,
    userEmail: user?.email ?? null,
    asOf,
  });

  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.filter(Boolean))]
    : null;
  const discoveryTargets = await prisma.targetPlaylist.findMany({
    where: {
      userId: opts.userId,
      enabled: true,
      ...(targetScope ? { id: { in: targetScope } } : {}),
    },
    orderBy: { priority: "asc" },
    select: {
      id: true,
      name: true,
      discoveryEnabled: true,
      discoveryFamiliarEnabled: true,
      discoveryRediscoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryReleasesEnabled: true,
      discoveryIntensity: true,
    },
  });
  const targetDiscoveryState = createTargetDiscoveryRuntimeState({
    userId: opts.userId,
    userEmail: user?.email ?? null,
    simulate,
    baseDiscoveryEnabled: discoveryState.enabled,
    targets: discoveryTargets.map((target) => ({
      targetPlaylistId: target.id,
      targetName: target.name,
      persistedPolicy: target,
    })),
  });

  const state: MusicRepeatRunState = {
    userId: opts.userId,
    simulate,
    context: prepared.context,
    initialSync: prepared.sync,
    repeatCompliance,
    recentlyPlayedSkippedCount: 0,
    missingTrackIdentitySkippedCount: 0,
    preWriteSync: null,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    preWriteMissingIdentityCount: 0,
    firstPartyPlaybackPreferences,
    firstPartyPreferenceEvidence: null,
    likedTrackSourceShadow: null,
  };

  const result = await runWithMusicRepeatState(state, () =>
    runWithMusic06PlannerRuntimeState(music06State, () =>
      runWithDiscoveryRuntimeState(discoveryState, () =>
        runWithTargetDiscoveryRuntimeState(targetDiscoveryState, () =>
          generatePlaylistsIncremental(opts),
        ),
      ),
    ),
  );

  // The underlying generator is authoritative for the execution result. If the
  // auxiliary observability cannot be appended afterwards, never turn a
  // successfully completed real write into an API-level failure/retry hazard.
  try {
    await appendRuntimeSummary(
      result.runId,
      state,
      music06State,
      discoveryState,
      targetDiscoveryState,
    );
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
  music06State: Music06PlannerRuntimeState,
  discoveryState: DiscoveryRuntimeState,
  targetDiscoveryState: TargetDiscoveryRuntimeState,
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
        firstPartyPlaybackPreferences: {
          loadedCount: state.firstPartyPlaybackPreferences.length,
          application: state.firstPartyPreferenceEvidence,
        },
        music06PlannerInfluence: music06PlannerRuntimeSummary(music06State),
        discoveryRuntime: discoveryRuntimeSummary(discoveryState),
        targetDiscoveryRuntime: targetDiscoveryRuntimeSummary(targetDiscoveryState),
        likedTrackSourceShadow: state.likedTrackSourceShadow ?? null,
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

function quarantinedMusicRepeatPreparation(): Awaited<
  ReturnType<typeof refreshMusicRepeatContext>
> {
  return {
    sync: {
      enabled: false,
      eventsRead: 0,
      identitiesUpdated: 0,
      listeningEventsInserted: 0,
      listeningEventsDuplicateCount: 0,
      listeningEventsSuppressedByHandoff: 0,
      historyKnownSince: null,
      lastSyncAt: null,
    },
    context: {
      enabled: false,
      windowValue: null,
      windowUnit: null,
      cutoff: null,
      historyKnownSince: null,
      lastSyncAt: null,
      blockedTrackIds: new Set<string>(),
    },
  };
}

function musicRepeatSummary(state: MusicRepeatRunState): Record<string, unknown> {
  const context = state.context;
  return {
    enabled: context.enabled,
    compliance: {
      source: "SPOTIFY_RECENTLY_PLAYED",
      lineage: state.repeatCompliance.lineage,
      uses: state.repeatCompliance.uses,
      decisions: state.repeatCompliance.decisions,
      productiveInfluenceAllowed: state.repeatCompliance.allowed,
      status: state.repeatCompliance.allowed ? "AUTHORIZED" : "QUARANTINED",
    },
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
