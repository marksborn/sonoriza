import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  createPodcast07RuntimeState,
  podcast07RuntimeSummary,
  runWithPodcast07RuntimeState,
  type Podcast07ShowOverrideRuntime,
  type Podcast07SourceDescriptor,
} from "@/services/spotify/podcast-07-runtime";
import { refreshAuthoritativePodcastListeningStates } from "@/services/spotify/podcast-authoritative-state";
import { loadPodcastSavedEpisodesPublishedHistory } from "@/services/spotify/podcast-saved-episodes-policy-history";
import { loadPodcastSavedEpisodesPolicy } from "@/services/spotify/podcast-saved-episodes-policy-store";
import { scopedTargetsMaySelectPodcast } from "@/services/spotify/podcast-refresh-applicability";
import { loadPodcastShowCadencePolicies } from "@/services/spotify/podcast-show-cadence-policy-store";
import { loadPodcastShowPolicies } from "@/services/spotify/podcast-show-policy-store";
import { planPodcast07PlaybackRefresh } from "@/services/spotify/podcast07-playback-refresh";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-base";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-base";

type Podcast07PlaybackRefreshEvidence = Readonly<{
  eligibleEpisodeCount: number;
  eligibleShowCount: number;
  selectedEpisodeCount: number;
  selectedShowCount: number;
  refreshedEpisodeCount: number;
  completedFoundCount: number;
  skippedByBudgetCount: number;
  selectedEpisodeIds: readonly string[];
  selectedByShowId: Readonly<Record<string, readonly string[]>>;
}>;

const EMPTY_PLAYBACK_REFRESH_EVIDENCE: Podcast07PlaybackRefreshEvidence = {
  eligibleEpisodeCount: 0,
  eligibleShowCount: 0,
  selectedEpisodeCount: 0,
  selectedShowCount: 0,
  refreshedEpisodeCount: 0,
  completedFoundCount: 0,
  skippedByBudgetCount: 0,
  selectedEpisodeIds: [],
  selectedByShowId: {},
};

/**
 * PODCAST-07 Gate 7 controlled runtime boundary shared by every generation
 * caller. The pre-Gate-7 generator lives in generate-playlists-base.ts, while
 * generate-playlists.ts is now a thin canonical facade over this wrapper.
 * OFF/SHADOW and non-allowlisted ACTIVE remain fail-closed to legacy behavior.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.map((value) => value.trim()).filter(Boolean))]
    : null;

  const [
    user,
    podcastSources,
    cadencePolicies,
    showPolicies,
    playbackRefreshTargets,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: opts.userId },
      select: { email: true },
    }),
    prisma.sourcePlaylist.findMany({
      where: { userId: opts.userId, kind: "PODCAST" },
      orderBy: { id: "asc" },
      select: {
        id: true,
        kind: true,
        spotifyType: true,
        spotifyId: true,
        name: true,
        enabled: true,
        includePlayed: true,
      },
    }),
    loadPodcastShowCadencePolicies(opts.userId),
    loadPodcastShowPolicies(opts.userId),
    prisma.targetPlaylist.findMany({
      where: {
        userId: opts.userId,
        enabled: true,
        ...(targetScope ? { id: { in: targetScope } } : {}),
      },
      select: {
        compositionMode: true,
        podcastPercent: true,
        sequencePattern: true,
      },
    }),
  ]);

  const proactivePlaybackRefreshRelevant =
    scopedTargetsMaySelectPodcast(playbackRefreshTargets);

  const savedSourceRow = podcastSources.find(
    (source) => source.spotifyType === "SAVED_EPISODES",
  );
  const savedSource: Podcast07SourceDescriptor | null = savedSourceRow
    ? {
        id: savedSourceRow.id,
        kind: savedSourceRow.kind,
        spotifyType: savedSourceRow.spotifyType,
        spotifyId: savedSourceRow.spotifyId,
        name: savedSourceRow.name,
        enabled: savedSourceRow.enabled,
        includePlayed: savedSourceRow.includePlayed,
      }
    : null;
  const defaultPolicy = savedSource
    ? await loadPodcastSavedEpisodesPolicy(opts.userId, savedSource.id)
    : null;
  const defaultPublishedEpisodeIdsByShow =
    savedSource && defaultPolicy?.enabled
      ? await loadPodcastSavedEpisodesPublishedHistory(opts.userId, savedSource.id)
      : new Map<string, readonly string[]>();

  let playbackRefreshEvidence = EMPTY_PLAYBACK_REFRESH_EVIDENCE;

  // #350 v2: refresh factual playback before cadence from the unresolved
  // publication backlog, not merely from the two newest publications. DB work
  // may inspect the known history, while provider IO remains hard-capped by the
  // pure planner. Updating lastObservedAt rotates the bounded budget across the
  // backlog on later generations.
  //
  // #397: this proactive provider work is useful only when at least one scoped
  // target can actually emit PODCAST. In particular, SEQUENCE ["MUSIC"] is
  // authoritative even if a legacy podcastPercent remains non-zero. The final
  // pre-write podcast revalidation remains unchanged for plans that do contain
  // podcasts.
  if (
    proactivePlaybackRefreshRelevant &&
    defaultPolicy?.enabled === true &&
    defaultPolicy.cadenceMaxEpisodes !== null &&
    defaultPolicy.cadenceUnit !== null
  ) {
    const publishedEpisodeIds = [
      ...new Set(
        [...defaultPublishedEpisodeIdsByShow.values()].flatMap((ids) => [...ids]),
      ),
    ];

    if (publishedEpisodeIds.length > 0) {
      const now = new Date();
      const refreshStateRows = await prisma.episodeListeningState.findMany({
        where: {
          userId: opts.userId,
          spotifyEpisodeId: { in: publishedEpisodeIds },
        },
        select: {
          spotifyEpisodeId: true,
          status: true,
          lastObservedAt: true,
        },
      });
      const refreshPlan = planPodcast07PlaybackRefresh({
        publishedEpisodeIdsByShow: defaultPublishedEpisodeIdsByShow,
        listeningStates: refreshStateRows,
        now,
      });

      let refreshedEpisodeCount = 0;
      let completedFoundCount = 0;
      if (refreshPlan.selectedEpisodeIds.length > 0) {
        const refreshed = await refreshAuthoritativePodcastListeningStates(
          opts.userId,
          refreshPlan.selectedEpisodeIds,
          now,
        );
        refreshedEpisodeCount = refreshed.size;
        completedFoundCount = [...refreshed.values()].filter(
          (entry) => entry.status === "COMPLETED",
        ).length;
      }

      playbackRefreshEvidence = {
        eligibleEpisodeCount: refreshPlan.eligibleEpisodeCount,
        eligibleShowCount: refreshPlan.eligibleShowCount,
        selectedEpisodeCount: refreshPlan.selectedEpisodeIds.length,
        selectedShowCount: refreshPlan.selectedShowCount,
        refreshedEpisodeCount,
        completedFoundCount,
        skippedByBudgetCount: refreshPlan.skippedByBudgetCount,
        selectedEpisodeIds: refreshPlan.selectedEpisodeIds,
        selectedByShowId: refreshPlan.selectedByShowId,
      };
    }
  }

  // Read after the bounded authoritative refresh so cadence sees any factual
  // transition discovered above without turning every generation into an
  // unbounded provider rescan.
  const listeningStates = await prisma.episodeListeningState.findMany({
    where: { userId: opts.userId },
    select: {
      spotifyEpisodeId: true,
      spotifyShowId: true,
      status: true,
      firstProgressObservedAt: true,
    },
  });

  const showOverrides: Podcast07ShowOverrideRuntime[] = podcastSources.flatMap(
    (source) => {
      if (source.spotifyType !== "SHOW") return [];
      const policy = showPolicies.get(source.id);
      if (!policy) return [];
      return [
        {
          sourcePlaylistId: source.id,
          spotifyShowId: source.spotifyId,
          showEpisodeScope: policy.showEpisodeScope ?? "ALL_EPISODES",
        },
      ];
    },
  );

  const state = createPodcast07RuntimeState({
    requestedMode: process.env.PODCAST_07_PLANNER_MODE ?? "SHADOW",
    userEmail: user?.email ?? null,
    activeEmailAllowlist:
      process.env.PODCAST_07_PLANNER_EMAIL_ALLOWLIST ?? null,
    // Gate 7 deliberately reuses PODCAST-06 civil-time authority.
    timeZone: process.env.PODCAST_06_SHADOW_TIMEZONE ?? null,
    savedSource,
    defaultPolicy,
    showOverrides,
    specificCadencePolicies: cadencePolicies,
    listeningStates: listeningStates.map((entry) => ({
      spotifyEpisodeId: entry.spotifyEpisodeId,
      spotifyShowId: entry.spotifyShowId,
      status: entry.status,
      firstProgressObservedAt: entry.firstProgressObservedAt,
    })),
    defaultPublishedEpisodeIdsByShow,
  });

  const result = await runWithPodcast07RuntimeState(state, () =>
    baseGeneratePlaylists(opts),
  );

  // The underlying generator remains authoritative. Observability failure after
  // a successful real Spotify write must not create a retry hazard.
  try {
    await appendPodcast07RuntimeSummary(
      result.runId,
      state,
      playbackRefreshEvidence,
    );
  } catch (error) {
    try {
      await prisma.generationLog.create({
        data: {
          runId: result.runId,
          level: "WARN",
          message: `PODCAST-07 runtime metrics persistence failed after generation: ${
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

async function appendPodcast07RuntimeSummary(
  runId: string,
  state: ReturnType<typeof createPodcast07RuntimeState>,
  playbackRefresh: Podcast07PlaybackRefreshEvidence,
): Promise<void> {
  const row = await prisma.generationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });
  const current =
    row?.summary &&
    typeof row.summary === "object" &&
    !Array.isArray(row.summary)
      ? (row.summary as Prisma.JsonObject)
      : {};
  const evidence = JSON.parse(
    JSON.stringify({
      ...podcast07RuntimeSummary(state),
      playbackRefresh,
    }),
  ) as Prisma.InputJsonValue;
  await prisma.generationRun.update({
    where: { id: runId },
    data: {
      summary: {
        ...current,
        podcast07Runtime: evidence,
      } as Prisma.InputJsonValue,
    },
  });
}
