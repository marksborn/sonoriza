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
import { resolveTargetCalendarScope } from "@/services/target-calendar-selection";
import { SpotifyClient } from "@/services/spotify";
import { refreshAuthoritativePodcastListeningStates } from "@/services/spotify/podcast-authoritative-state";
import { prismaPodcastListeningStateStore } from "@/services/spotify/podcast-listening-state";
import { evaluatePodcastShowCandidateEligibility } from "@/services/spotify/podcast-show-policy";
import { loadPodcastShowPolicies } from "@/services/spotify/podcast-show-policy-store";
import { loadMusicRepeatContext } from "@/services/spotify/recently-played";
import {
  lastFmMusicIdentityKey,
  mustBlockRealWriteForLastFmFactualCooldown,
  prepareLastFmFactualCooldown,
} from "@/jobs/music-repeat-runtime";

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

/**
 * CALENDAR-127 scope parity: KEEP_FILLED preflight must resolve the same
 * destination-specific calendars as the generator. Otherwise it can preserve
 * against the legacy global sum (e.g. 16h40) while the actual plan only
 * targets the destination's selected events (e.g. 130 min).
 * Fail closed on an invalid SELECTED scope; never silently fall back.
 */
async function resolveKeepFilledTargetCalendarIds(
  userId: string,
  target: TargetPlaylist,
): Promise<string[]> {
  const selectedCalendars = await prisma.calendarSelection.findMany({
    where: { userId, selected: true },
    select: { id: true, googleCalendarId: true, usedForDuration: true },
  });
  const queryableCalendarIds = selectedCalendars.map(
    (calendar) => calendar.googleCalendarId,
  );
  const legacyDurationCalendarIds = selectedCalendars
    .filter((calendar) => calendar.usedForDuration)
    .map((calendar) => calendar.googleCalendarId);

  if (target.durationMode !== "CALENDAR" ||
      target.calendarMode === "LEGACY_GLOBAL") {
    return resolveTargetCalendarScope({
      mode: "LEGACY_GLOBAL",
      selectedGoogleCalendarIds: [],
      queryableCalendarIds,
      legacyDurationCalendarIds,
    }).calendarIds;
  }

  let selectedGoogleCalendarIds: string[] = [];
  if (target.calendarMode === "SELECTED") {
    const links = await prisma.targetPlaylistCalendar.findMany({
      where: { targetPlaylistId: target.id },
      select: {
        calendarSelection: {
          select: {
            userId: true,
            selected: true,
            googleCalendarId: true,
          },
        },
      },
    });
    if (
      links.length === 0 ||
      links.some((link) =>
        link.calendarSelection.userId !== userId ||
        !link.calendarSelection.selected
      )
    ) {
      throw new Error(
        `Target "${target.name}" has an unavailable selected calendar`,
      );
    }
    selectedGoogleCalendarIds = links.map(
      (link) => link.calendarSelection.googleCalendarId,
    );
  }

  const scope = resolveTargetCalendarScope({
    mode: target.calendarMode,
    selectedGoogleCalendarIds,
    queryableCalendarIds,
    legacyDurationCalendarIds,
  });
  if (scope.calendarIds.length === 0) {
    throw new Error(
      `Target "${target.name}" resolved an empty ${scope.mode} calendar scope`,
    );
  }
  return scope.calendarIds;
}

export async function prepareKeepFilledTarget(
  userId: string,
  target: TargetPlaylist,
  date = new Date(),
  // Callers may supply the already-validated target-specific scope.
  // Without an override, resolve the same CALENDAR-127 scope as generation.
  durationCalendarIdsOverride?: readonly string[],
  simulate = false,
): Promise<PreparedKeepFilledTarget> {
  if (!target.spotifyPlaylistId) {
    throw new Error(`Target "${target.name}" has no Spotify playlist`);
  }

  const durationCalendarIds = durationCalendarIdsOverride
    ? [...durationCalendarIdsOverride]
    : await resolveKeepFilledTargetCalendarIds(userId, target);
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

  // #512: KEEP_FILLED preflight runs before the planner's Last.fm runtime.
  // Preserved tracks must use the same factual eligibility, otherwise they
  // bypass the six-month rule despite new candidates being excluded.
  // Empty-calendar CLEAR and podcast-only playlists have no music to vet.
  const hasReadableMusic = remote.items.some(
    (item) => item.type === "MUSIC" && item.musicCandidate && item.uri,
  );
  const factual = !willClearEmptyCalendar && hasReadableMusic
    ? await prepareLastFmFactualCooldown(userId, new Date())
    : null;

  if (factual && mustBlockRealWriteForLastFmFactualCooldown(factual, simulate)) {
    throw new Error(
      "KEEP_FILLED: cooldown factual Last.fm indisponível ou incompleto; " +
        "nenhuma alteração foi realizada no Spotify.",
    );
  }

  const factualBlockedUris = new Set<string>();
  if (
    factual?.effectiveMode === "ACTIVE" &&
    factual.status === "READY_ACTIVE" &&
    factual.providerComplete === true
  ) {
    for (const item of remote.items) {
      if (item.type !== "MUSIC" || !item.musicCandidate || !item.uri) continue;
      const candidate = item.musicCandidate;
      const key = lastFmMusicIdentityKey(
        candidate.title,
        candidate.primaryArtistName ?? candidate.subtitle ?? item.subtitle,
      );
      // Never publish a preserved track with unknown factual identity while
      // the explicit cooldown rule is ACTIVE. Ambiguity is not an opt-out.
      if (!key) {
        throw new Error(
          "KEEP_FILLED: identidade musical insuficiente para validar " +
            "a preservação sob a regra Last.fm ACTIVE.",
        );
      }
      if (factual.blockedIdentityKeys.has(key)) factualBlockedUris.add(item.uri);
    }
  }

  const musicRepeat = await loadMusicRepeatContext(userId, date);
  const preservation = buildKeepFilledPreservation({
    items: remote.items,
    podcastStates,
    provenanceByUri,
    podcastShowPolicyByUri,
    // Spotify Recently Played is not allowed to override the factual
    // Last.fm source when ACTIVE; its separate quarantine remains intact.
    musicRepeatEnabled: factual?.effectiveMode === "ACTIVE"
      ? false
      : musicRepeat.enabled,
    blockedTrackIds: musicRepeat.blockedTrackIds,
    lastFmFactualBlockedUris: factualBlockedUris,
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
