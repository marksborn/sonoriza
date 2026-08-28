import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import {
  buildKeepFilledPreservation,
  type GeneratedItemProvenance,
  type PodcastShowMaintenancePolicy,
} from "@/services/keep-filled-core";
import type { Candidate } from "@/services/playlist-planner";
import { parseSequencePattern } from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";
import { refreshAuthoritativePodcastListeningStates } from "@/services/spotify/podcast-authoritative-state";
import { prismaPodcastListeningStateStore } from "@/services/spotify/podcast-listening-state";
import { evaluatePodcastShowCandidateEligibility } from "@/services/spotify/podcast-show-policy";
import { loadPodcastShowPolicies } from "@/services/spotify/podcast-show-policy-store";
import { loadMusicRepeatContext } from "@/services/spotify/recently-played";

export type KeepFilledTargetPatch = {
  snapshotBefore: string;
  preservedUris: string[];
  removeUris: string[];
  forceReplace: boolean;
  targetDurationMs: number;
  validDurationBeforeMs: number;
  removedDurationMs: number;
  preservedCount: number;
  removedCount: number;
  unknownReplayPolicyCount: number;
};

export type PreparedKeepFilledTarget = {
  targetPlaylistId: string;
  preserved: Candidate[];
  patch: KeepFilledTargetPatch;
  skipReason: "EMPTY_CALENDAR_KEEP" | "EMPTY_CALENDAR_SKIP" | null;
};

export async function prepareKeepFilledTarget(
  userId: string,
  target: TargetPlaylist,
  date = new Date(),
): Promise<PreparedKeepFilledTarget> {
  if (!target.spotifyPlaylistId) {
    throw new Error(`Target "${target.name}" has no Spotify playlist`);
  }

  const durationCalendarIds = (
    await prisma.calendarSelection.findMany({
      where: { userId, selected: true, usedForDuration: true },
      select: { googleCalendarId: true },
    })
  ).map((entry) => entry.googleCalendarId);
  const resolved = await resolveTargetDuration(
    userId,
    target,
    durationCalendarIds,
    date,
    () => undefined,
  );

  if (target.durationMode === "CALENDAR" && resolved.durationMs <= 0) {
    if (target.emptyCalendarBehavior === "KEEP") {
      return emptyCalendarSkip(target.id, "EMPTY_CALENDAR_KEEP");
    }
    if (target.emptyCalendarBehavior === "SKIP") {
      return emptyCalendarSkip(target.id, "EMPTY_CALENDAR_SKIP");
    }
  }

  const spotify = await SpotifyClient.forUser(userId);
  const remote = await spotify.getTargetPlaylistState(target.spotifyPlaylistId);
  const observations = remote.items.flatMap((item) => {
    if (item.type !== "PODCAST" || !item.uri || !item.spotifyEpisodeId) {
      return [];
    }
    return [
      {
        spotifyEpisodeId: item.spotifyEpisodeId,
        spotifyUri: item.uri,
        durationMs: Math.max(0, item.originalDurationMs ?? 0),
        resumePositionMs: item.providerResumePositionMs ?? null,
        fullyPlayed: item.providerFullyPlayed ?? null,
        observedAt: date,
      },
    ];
  });
  const observedPodcastStates = await prismaPodcastListeningStateStore.observe(
    userId,
    observations,
  );

  const liveUris = new Set(
    remote.items.flatMap((item) => (item.uri ? [item.uri] : [])),
  );
  const previousRun =
    liveUris.size === 0
      ? null
      : await prisma.generationRun.findFirst({
          where: {
            userId,
            simulation: false,
            status: { in: ["SUCCESS", "PARTIAL"] },
            items: { some: { targetPlaylistId: target.id } },
          },
          orderBy: { startedAt: "desc" },
          select: {
            items: {
              where: { targetPlaylistId: target.id },
              select: {
                spotifyUri: true,
                sourceSpotifyType: true,
                sourceSpotifyId: true,
                sourceIncludePlayed: true,
              },
            },
          },
        });

  const provenanceByUri = new Map<string, GeneratedItemProvenance>();
  for (const item of previousRun?.items ?? []) {
    if (!liveUris.has(item.spotifyUri) || provenanceByUri.has(item.spotifyUri)) {
      continue;
    }
    provenanceByUri.set(item.spotifyUri, {
      sourceSpotifyType: item.sourceSpotifyType,
      sourceSpotifyId: item.sourceSpotifyId,
      sourceIncludePlayed: item.sourceIncludePlayed,
    });
  }

  // P2 (SCHEDULE-03 follow-up): an empty-calendar CLEAR removes every item and
  // never preserves playback state, so it must not depend on the authoritative
  // episode reads. A transient 429/404 there could otherwise block the run and
  // leave the target filled. Skip the reads entirely on the CLEAR path.
  const willClearEmptyCalendar =
    target.durationMode === "CALENDAR" &&
    resolved.durationMs <= 0 &&
    target.emptyCalendarBehavior === "CLEAR";

  // SCHEDULE-03: a playlist-item resume_point can lag the playback state shown
  // by Spotify. Before preserving a podcast whose provenance does not explicitly
  // allow replay, ask the episode endpoint directly and merge that observation
  // into PODCAST-04's sticky canonical state. This is intentionally limited to
  // the small set of podcast items already present in this target.
  const authoritativeEpisodeIds = willClearEmptyCalendar
    ? []
    : remote.items.flatMap((item) => {
        if (
          item.type !== "PODCAST" ||
          !item.uri ||
          !item.spotifyEpisodeId ||
          provenanceByUri.get(item.uri)?.sourceIncludePlayed === true
        ) {
          return [];
        }
        return [item.spotifyEpisodeId];
      });
  const authoritativePodcastStates =
    await refreshAuthoritativePodcastListeningStates(
      userId,
      authoritativeEpisodeIds,
      date,
      { episodeReader: (episodeId) => spotify.getEpisodePlaybackState(episodeId) },
    );
  const podcastStates = new Map(observedPodcastStates);
  for (const [episodeId, state] of authoritativePodcastStates) {
    podcastStates.set(episodeId, state);
  }

  const podcastShowPolicyByUri = willClearEmptyCalendar
    ? new Map<string, PodcastShowMaintenancePolicy>()
    : await buildPodcastShowMaintenancePolicies({
        userId,
        date,
        remoteItems: remote.items,
        provenanceByUri,
        podcastStates,
        spotify,
      });

  const musicRepeat = await loadMusicRepeatContext(userId, date);
  const preservation = buildKeepFilledPreservation({
    items: remote.items,
    podcastStates,
    provenanceByUri,
    podcastShowPolicyByUri,
    musicRepeatEnabled: musicRepeat.enabled,
    blockedTrackIds: musicRepeat.blockedTrackIds,
    rules: {
      compositionMode: target.compositionMode,
      sequencePattern: parseSequencePattern(target.sequencePattern),
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
      maxTracksPerArtist: target.maxTracksPerArtist,
      maxTracksPerAlbum: target.maxTracksPerAlbum,
    },
    maxPodcastDurationMs: resolved.podcastEpisodeMaxDurationMs,
  });

  if (willClearEmptyCalendar) {
    return {
      targetPlaylistId: target.id,
      preserved: [],
      patch: {
        snapshotBefore: remote.snapshotId,
        preservedUris: [],
        removeUris: [
          ...new Set(
            remote.items.flatMap((item) =>
              item.uri && item.removableByUri ? [item.uri] : [],
            ),
          ),
        ],
        forceReplace: true,
        targetDurationMs: 0,
        validDurationBeforeMs: preservation.validDurationBeforeMs,
        removedDurationMs:
          preservation.validDurationBeforeMs + preservation.removedDurationMs,
        preservedCount: 0,
        removedCount: remote.items.length,
        unknownReplayPolicyCount: preservation.unknownReplayPolicyCount,
      },
      skipReason: null,
    };
  }

  if (preservation.unknownReplayPolicyCount > 0) {
    throw new Error(
      `Target "${target.name}" contém episódio concluído sem proveniência suficiente para provar a política de replay; manutenção incremental bloqueada sem escrita.`,
    );
  }

  return {
    targetPlaylistId: target.id,
    preserved: preservation.preserved,
    patch: {
      snapshotBefore: remote.snapshotId,
      preservedUris: preservation.preserved.map((item) => item.uri),
      removeUris: preservation.removeUris,
      forceReplace: preservation.forceReplace,
      targetDurationMs: resolved.durationMs,
      validDurationBeforeMs: preservation.validDurationBeforeMs,
      removedDurationMs: preservation.removedDurationMs,
      preservedCount: preservation.preservedCount,
      removedCount: preservation.removedCount,
      unknownReplayPolicyCount: preservation.unknownReplayPolicyCount,
    },
    skipReason: null,
  };
}

async function buildPodcastShowMaintenancePolicies(input: {
  userId: string;
  date: Date;
  remoteItems: Awaited<ReturnType<SpotifyClient["getTargetPlaylistState"]>>["items"];
  provenanceByUri: ReadonlyMap<string, GeneratedItemProvenance>;
  podcastStates: ReadonlyMap<
    string,
    Awaited<ReturnType<typeof prismaPodcastListeningStateStore.observe>> extends Map<
      string,
      infer State
    >
      ? State
      : never
  >;
  spotify: SpotifyClient;
}): Promise<Map<string, PodcastShowMaintenancePolicy>> {
  const [showSources, policies] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId: input.userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
      },
      select: { id: true, spotifyId: true },
    }),
    loadPodcastShowPolicies(input.userId),
  ]);
  const policyBySpotifyShowId = new Map(
    showSources.flatMap((source) => {
      const policy = policies.get(source.id);
      return policy ? [[source.spotifyId, policy] as const] : [];
    }),
  );
  const result = new Map<string, PodcastShowMaintenancePolicy>();

  for (const item of input.remoteItems) {
    if (
      item.type !== "PODCAST" ||
      !item.uri ||
      !item.spotifyEpisodeId
    ) {
      continue;
    }
    const provenance = input.provenanceByUri.get(item.uri);
    if (
      provenance?.sourceSpotifyType !== "SHOW" ||
      !provenance.sourceSpotifyId
    ) {
      continue;
    }
    const policy = policyBySpotifyShowId.get(provenance.sourceSpotifyId);
    if (!policy) continue;

    const state = input.podcastStates.get(item.spotifyEpisodeId);
    let blockedReason: PodcastShowMaintenancePolicy["blockedReason"] = null;

    if (state) {
      const baseCandidate: Candidate = {
        uri: item.uri,
        spotifyEpisodeId: item.spotifyEpisodeId,
        type: "PODCAST",
        title: item.title ?? "Podcast",
        programId: item.programId ?? provenance.sourceSpotifyId,
        durationMs: Math.max(0, item.originalDurationMs ?? state.durationMs),
        podcastListeningStatus: state.status,
        podcastFirstProgressObservedAt: state.firstProgressObservedAt,
      };
      const stateFailure = evaluatePodcastShowCandidateEligibility(
        baseCandidate,
        { ...policy, maxReleaseAgeDays: null },
        input.date,
      );

      if (stateFailure === "STATE_FILTERED") {
        blockedReason = "PODCAST_SHOW_STATE_FILTERED";
      } else if (policy.maxReleaseAgeDays !== null) {
        const episode = (await input.spotify.getEpisodePlaybackState(
          item.spotifyEpisodeId,
        )) as Awaited<ReturnType<SpotifyClient["getEpisodePlaybackState"]>> & {
          release_date?: string;
          release_date_precision?: string;
        };
        const freshnessFailure = evaluatePodcastShowCandidateEligibility(
          {
            ...baseCandidate,
            releaseDate: episode.release_date,
            releaseDatePrecision: episode.release_date_precision,
          },
          policy,
          input.date,
        );
        if (freshnessFailure === "RELEASE_EXPIRED") {
          blockedReason = "PODCAST_SHOW_RELEASE_EXPIRED";
        } else if (freshnessFailure === "RELEASE_UNKNOWN") {
          blockedReason = "PODCAST_SHOW_RELEASE_UNKNOWN";
        }
      }
    }

    result.set(item.uri, {
      replayAllowed: policy.episodeEligibility !== "UNPLAYED_ONLY",
      maxEpisodesPerCycle: policy.maxEpisodesPerCycle,
      blockedReason,
    });
  }

  return result;
}

function emptyCalendarSkip(
  targetPlaylistId: string,
  skipReason: "EMPTY_CALENDAR_KEEP" | "EMPTY_CALENDAR_SKIP",
): PreparedKeepFilledTarget {
  return {
    targetPlaylistId,
    preserved: [],
    patch: {
      snapshotBefore: "",
      preservedUris: [],
      removeUris: [],
      forceReplace: false,
      targetDurationMs: 0,
      validDurationBeforeMs: 0,
      removedDurationMs: 0,
      preservedCount: 0,
      removedCount: 0,
      unknownReplayPolicyCount: 0,
    },
    skipReason,
  };
}
