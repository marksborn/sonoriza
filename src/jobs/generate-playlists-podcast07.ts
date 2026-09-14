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
import { loadPodcastShowCadencePolicies } from "@/services/spotify/podcast-show-cadence-policy-store";
import { loadPodcastShowPolicies } from "@/services/spotify/podcast-show-policy-store";
import {
  recentPublishedEpisodeIds,
  selectPodcast07PlaybackRefreshEpisodeIds,
} from "@/services/spotify/podcast07-playback-refresh";

import {
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-base";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-base";

/**
 * PODCAST-07 Gate 7 controlled runtime boundary shared by every generation
 * caller. The pre-Gate-7 generator lives in generate-playlists-base.ts, while
 * generate-playlists.ts is now a thin canonical facade over this wrapper.
 * OFF/SHADOW and non-allowlisted ACTIVE remain fail-closed to legacy behavior.
 */
export async function generatePlaylists(
  opts: GeneratePlaylistsOptions,
): Promise<GeneratePlaylistsResult> {
  const [user, podcastSources, cadencePolicies, showPolicies] = await Promise.all([
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
  ]);

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

  // #350: refresh factual playback before cadence, but never traverse the full
  // publication history on every generation. The pure selector owns the hard
  // quota/TTL/window rules; this query is restricted to only the two most recent
  // published episode IDs per show so the DB work is bounded before provider IO.
  if (
    defaultPolicy?.enabled === true &&
    defaultPolicy.cadenceMaxEpisodes !== null &&
    defaultPolicy.cadenceUnit !== null
  ) {
    const recentPublishedIds = recentPublishedEpisodeIds(
      defaultPublishedEpisodeIdsByShow,
    );

    if (recentPublishedIds.size > 0) {
      const now = new Date();
      const refreshStateRows = await prisma.episodeListeningState.findMany({
        where: {
          userId: opts.userId,
          spotifyEpisodeId: { in: [...recentPublishedIds] },
        },
        select: {
          spotifyEpisodeId: true,
          status: true,
          lastObservedAt: true,
        },
      });
      const refreshEpisodeIds = selectPodcast07PlaybackRefreshEpisodeIds({
        publishedEpisodeIdsByShow: defaultPublishedEpisodeIdsByShow,
        listeningStates: refreshStateRows,
        now,
      });

      if (refreshEpisodeIds.length > 0) {
        await refreshAuthoritativePodcastListeningStates(
          opts.userId,
          refreshEpisodeIds,
          now,
        );
      }
    }
  }

  // Read after the bounded authoritative refresh so cadence sees any factual
  // transition discovered above without turning every generation into a full
  // playback-state rescan.
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
    await appendPodcast07RuntimeSummary(result.runId, state);
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
    JSON.stringify(podcast07RuntimeSummary(state)),
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
