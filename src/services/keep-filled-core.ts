import type { Candidate, PlaylistRules } from "@/services/playlist-planner";

export type CurrentTargetPlaylistItem = {
  position: number;
  uri: string | null;
  type: "MUSIC" | "PODCAST" | null;
  title?: string;
  subtitle?: string;
  musicCandidate?: Candidate | null;
  spotifyEpisodeId?: string | null;
  programId?: string | null;
  originalDurationMs?: number;
  providerResumePositionMs?: number | null;
  providerFullyPlayed?: boolean | null;
  removableByUri: boolean;
};

export type CanonicalPodcastStateForMaintenance = {
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  durationMs: number;
  resumePositionMs: number;
};

export type GeneratedItemProvenance = {
  sourceSpotifyType?: "PLAYLIST" | "SHOW" | "SAVED_EPISODES" | null;
  sourceSpotifyId?: string | null;
  sourceIncludePlayed?: boolean | null;
};

export type KeepFilledRemovalReason =
  | "UNREADABLE_ITEM"
  | "DUPLICATE_URI"
  | "MUSIC_RECENTLY_PLAYED"
  | "MUSIC_IDENTITY_MISSING"
  | "PODCAST_IDENTITY_MISSING"
  | "PODCAST_COMPLETED_NO_REPLAY"
  | "PODCAST_DURATION_LIMIT"
  | "PODCAST_PROGRAM_LIMIT"
  | "MUSIC_ARTIST_IDENTITY_MISSING"
  | "MUSIC_ALBUM_IDENTITY_MISSING"
  | "MUSIC_ARTIST_LIMIT"
  | "MUSIC_ALBUM_LIMIT"
  | "SEQUENCE_TYPE_MISMATCH";

export type KeepFilledRemoval = {
  position: number;
  uri: string | null;
  type: CurrentTargetPlaylistItem["type"];
  durationMs: number;
  reason: KeepFilledRemovalReason;
};

export type KeepFilledPreservation = {
  preserved: Candidate[];
  removeUris: string[];
  removals: KeepFilledRemoval[];
  validDurationBeforeMs: number;
  removedDurationMs: number;
  preservedCount: number;
  removedCount: number;
  unknownReplayPolicyCount: number;
  forceReplace: boolean;
};

export function buildKeepFilledPreservation(input: {
  items: CurrentTargetPlaylistItem[];
  podcastStates: ReadonlyMap<string, CanonicalPodcastStateForMaintenance>;
  provenanceByUri: ReadonlyMap<string, GeneratedItemProvenance>;
  musicRepeatEnabled: boolean;
  blockedTrackIds: ReadonlySet<string>;
  rules: Pick<
    PlaylistRules,
    | "compositionMode"
    | "sequencePattern"
    | "maxEpisodesPerProgram"
    | "maxTracksPerArtist"
    | "maxTracksPerAlbum"
  >;
  maxPodcastDurationMs: number | null;
}): KeepFilledPreservation {
  const preserved: Candidate[] = [];
  const removals: KeepFilledRemoval[] = [];
  const removeUris: string[] = [];
  const seenUris = new Set<string>();
  const duplicateUris = new Set<string>();
  const uriCounts = new Map<string, number>();
  for (const item of input.items) {
    if (!item.uri) continue;
    uriCounts.set(item.uri, (uriCounts.get(item.uri) ?? 0) + 1);
  }
  for (const [uri, count] of uriCounts) if (count > 1) duplicateUris.add(uri);

  const programCounts = new Map<string, number>();
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  let validDurationBeforeMs = 0;
  let removedDurationMs = 0;
  let unknownReplayPolicyCount = 0;
  let forceReplace = false;

  const remove = (
    item: CurrentTargetPlaylistItem,
    reason: KeepFilledRemovalReason,
    durationMs = 0,
  ) => {
    const normalizedDuration = Math.max(0, Math.trunc(durationMs));
    removals.push({
      position: item.position,
      uri: item.uri,
      type: item.type,
      durationMs: normalizedDuration,
      reason,
    });
    removedDurationMs += normalizedDuration;
    if (item.uri && item.removableByUri && !duplicateUris.has(item.uri)) {
      removeUris.push(item.uri);
    } else {
      forceReplace = true;
    }
  };

  for (const item of [...input.items].sort((a, b) => a.position - b.position)) {
    if (!item.uri || !item.type) {
      remove(item, "UNREADABLE_ITEM", item.originalDurationMs ?? 0);
      continue;
    }
    if (seenUris.has(item.uri)) {
      remove(item, "DUPLICATE_URI", item.originalDurationMs ?? item.musicCandidate?.durationMs ?? 0);
      forceReplace = true;
      continue;
    }

    let candidate: Candidate | null = null;

    if (item.type === "MUSIC") {
      candidate = item.musicCandidate ?? null;
      if (!candidate) {
        remove(item, "UNREADABLE_ITEM", item.originalDurationMs ?? 0);
        continue;
      }
      if (input.musicRepeatEnabled) {
        if (!candidate.spotifyTrackId) {
          remove(item, "MUSIC_IDENTITY_MISSING", candidate.durationMs);
          continue;
        }
        if (input.blockedTrackIds.has(candidate.spotifyTrackId)) {
          remove(item, "MUSIC_RECENTLY_PLAYED", candidate.durationMs);
          continue;
        }
      }
    } else {
      const episodeId = item.spotifyEpisodeId?.trim();
      const programId = item.programId?.trim();
      if (!episodeId || !programId) {
        remove(item, "PODCAST_IDENTITY_MISSING", item.originalDurationMs ?? 0);
        continue;
      }
      const state = input.podcastStates.get(episodeId);
      if (!state) {
        remove(item, "PODCAST_IDENTITY_MISSING", item.originalDurationMs ?? 0);
        continue;
      }
      const originalDurationMs = Math.max(
        0,
        Math.trunc(item.originalDurationMs ?? state.durationMs),
      );
      const provenance = input.provenanceByUri.get(item.uri);
      const replayAllowed = provenance?.sourceIncludePlayed ?? null;

      if (state.status === "COMPLETED" && replayAllowed === false) {
        remove(item, "PODCAST_COMPLETED_NO_REPLAY", originalDurationMs);
        continue;
      }

      let durationMs: number;
      if (state.status === "COMPLETED") {
        if (replayAllowed === null) unknownReplayPolicyCount += 1;
        const activeReplayPosition =
          replayAllowed === true &&
          item.providerFullyPlayed === false &&
          (item.providerResumePositionMs ?? 0) > 0
            ? Math.min(originalDurationMs, Math.max(0, item.providerResumePositionMs ?? 0))
            : null;
        durationMs =
          activeReplayPosition === null
            ? originalDurationMs
            : Math.max(0, originalDurationMs - activeReplayPosition);
      } else {
        const resume = Math.min(
          originalDurationMs,
          Math.max(0, state.resumePositionMs),
        );
        durationMs = Math.max(0, originalDurationMs - resume);
      }

      if (durationMs <= 0) {
        remove(item, "PODCAST_COMPLETED_NO_REPLAY", originalDurationMs);
        continue;
      }
      if (
        input.maxPodcastDurationMs !== null &&
        durationMs > input.maxPodcastDurationMs
      ) {
        remove(item, "PODCAST_DURATION_LIMIT", durationMs);
        continue;
      }

      candidate = {
        uri: item.uri,
        type: "PODCAST",
        title: item.title ?? "Podcast",
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        programId,
        durationMs,
        originalDurationMs,
        resumePositionMs: Math.max(0, originalDurationMs - durationMs),
        playbackPositionKnown: true,
        ...(provenance?.sourceSpotifyType
          ? { sourceSpotifyType: provenance.sourceSpotifyType }
          : {}),
        ...(provenance?.sourceSpotifyId
          ? { sourceSpotifyId: provenance.sourceSpotifyId }
          : {}),
        ...(replayAllowed !== null ? { sourceIncludePlayed: replayAllowed } : {}),
      };
    }

    if (
      input.rules.compositionMode === "SEQUENCE" &&
      input.rules.sequencePattern.length > 0 &&
      candidate.type !==
        input.rules.sequencePattern[preserved.length % input.rules.sequencePattern.length]
    ) {
      remove(item, "SEQUENCE_TYPE_MISMATCH", candidate.durationMs);
      continue;
    }

    if (candidate.type === "PODCAST") {
      const programId = candidate.programId!;
      const count = programCounts.get(programId) ?? 0;
      if (count >= input.rules.maxEpisodesPerProgram) {
        remove(item, "PODCAST_PROGRAM_LIMIT", candidate.durationMs);
        continue;
      }
      programCounts.set(programId, count + 1);
    } else {
      const artistLimit = normalizeLimit(input.rules.maxTracksPerArtist);
      const albumLimit = normalizeLimit(input.rules.maxTracksPerAlbum);
      if (artistLimit !== null) {
        if (!candidate.primaryArtistId) {
          remove(item, "MUSIC_ARTIST_IDENTITY_MISSING", candidate.durationMs);
          continue;
        }
        const count = artistCounts.get(candidate.primaryArtistId) ?? 0;
        if (count >= artistLimit) {
          remove(item, "MUSIC_ARTIST_LIMIT", candidate.durationMs);
          continue;
        }
      }
      if (albumLimit !== null) {
        if (!candidate.albumId) {
          remove(item, "MUSIC_ALBUM_IDENTITY_MISSING", candidate.durationMs);
          continue;
        }
        const count = albumCounts.get(candidate.albumId) ?? 0;
        if (count >= albumLimit) {
          remove(item, "MUSIC_ALBUM_LIMIT", candidate.durationMs);
          continue;
        }
      }
      if (artistLimit !== null && candidate.primaryArtistId) {
        artistCounts.set(
          candidate.primaryArtistId,
          (artistCounts.get(candidate.primaryArtistId) ?? 0) + 1,
        );
      }
      if (albumLimit !== null && candidate.albumId) {
        albumCounts.set(candidate.albumId, (albumCounts.get(candidate.albumId) ?? 0) + 1);
      }
    }

    seenUris.add(item.uri);
    preserved.push(candidate);
    validDurationBeforeMs += Math.max(0, candidate.durationMs);
  }

  if (duplicateUris.size > 0 && removals.some((entry) => entry.uri && duplicateUris.has(entry.uri))) {
    forceReplace = true;
  }

  return {
    preserved,
    removeUris: [...new Set(removeUris)],
    removals,
    validDurationBeforeMs,
    removedDurationMs,
    preservedCount: preserved.length,
    removedCount: removals.length,
    unknownReplayPolicyCount,
    forceReplace,
  };
}

function normalizeLimit(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}
