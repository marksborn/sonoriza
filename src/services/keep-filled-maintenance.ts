import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import {
  buildKeepFilledPreservation,
  type GeneratedItemProvenance,
} from "@/services/keep-filled-core";
import type { Candidate } from "@/services/playlist-planner";
import { parseSequencePattern } from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";
import { refreshAuthoritativePodcastListeningStates } from "@/services/spotify/podcast-authoritative-state";
import { prismaPodcastListeningStateStore } from "@/services/spotify/podcast-listening-state";
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
    if (
      item.type !== "PODCAST" ||
      !item.uri ||
      !item.spotifyEpisodeId
    ) {
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

  // SCHEDULE-03: a playlist-item resume_point can lag the playback state shown
  // by Spotify. Before preserving a podcast whose provenance does not explicitly
  // allow replay, ask the episode endpoint directly and merge that observation
  // into PODCAST-04's sticky canonical state. This is intentionally limited to
  // the small set of podcast items already present in this target.
  const authoritativeEpisodeIds = remote.items.flatMap((item) => {
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
    );
  const podcastStates = new Map(observedPodcastStates);
  for (const [episodeId, state] of authoritativePodcastStates) {
    podcastStates.set(episodeId, state);
  }

  const musicRepeat = await loadMusicRepeatContext(userId, date);
  const preservation = buildKeepFilledPreservation({
    items: remote.items,
    podcastStates,
    provenanceByUri,
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

  if (
    target.durationMode === "CALENDAR" &&
    resolved.durationMs <= 0 &&
    target.emptyCalendarBehavior === "CLEAR"
  ) {
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
