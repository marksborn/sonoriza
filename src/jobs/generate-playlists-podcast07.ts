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
  generatePlaylists as baseGeneratePlaylists,
  type GeneratePlaylistsOptions,
  type GeneratePlaylistsResult,
} from "./generate-playlists-base";

export type {
  GeneratePlaylistsOptions,
  GeneratePlaylistsResult,
} from "./generate-playlists-base";

const PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES = 8;
const PODCAST07_PLAYBACK_REFRESH_TTL_MS = 60 * 60 * 1000;
const PODCAST07_PLAYBACK_REFRESH_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const PODCAST07_PLAYBACK_REFRESH_RECENT_PER_SHOW = 2;

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
  // publication history on every generation. Only a small, recent set of
  // unresolved episodes can produce provider reads:
  // - at most the two most recently published episodes per show;
  // - only NOT_STARTED / IN_PROGRESS canonical rows;
  // - only rows observed in the recent planning window;
  // - at most eight direct Spotify reads per generation;
  // - a one-hour TTL prevents repeatedly refreshing the same row.
  //
  // COMPLETED is sticky in the canonical merge, so completed rows never need a
  // provider refresh here. The normal collection/pre-write paths remain intact.
  if (
    defaultPolicy?.enabled === true &&
    defaultPolicy.cadenceMaxEpisodes !== null &&
    defaultPolicy.cadenceUnit !== null
  ) {
    const recentPublishedIds = new Set<string>();
    for (const episodeIds of defaultPublishedEpisodeIdsByShow.values()) {
      const uniqueRecent = [...new Set([...episodeIds].reverse())].slice(
        0,
        PODCAST07_PLAYBACK_REFRESH_RECENT_PER_SHOW,
      );
      for (const episodeId of uniqueRecent) recentPublishedIds.add(episodeId);
    }

    if (recentPublishedIds.size > 0) {
      const now = new Date();
      const staleBefore = new Date(
        now.getTime() - PODCAST07_PLAYBACK_REFRESH_TTL_MS,
      );
      const recentAfter = new Date(
        now.getTime() - PODCAST07_PLAYBACK_REFRESH_RECENT_WINDOW_MS,
      );
      const refreshCandidates = await prisma.episodeListeningState.findMany({
        where: {
          userId: opts.userId,
          spotifyEpisodeId: { in: [...recentPublishedIds] },
          status: { in: ["NOT_STARTED", "IN_PROGRESS"] },
          lastObservedAt: {
            gte: recentAfter,
            lte: staleBefore,
          },
        },
        orderBy: { lastObservedAt: "desc" },
        take: PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES,
        select: { spotifyEpisodeId: true },
      });

      if (refreshCandidates.length > 0) {
        await refreshAuthoritativePodcastListeningStates(
          opts.userId,
          refreshCandidates.map((entry) => entry.spotifyEpisodeId),
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
