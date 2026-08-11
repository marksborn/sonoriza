from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# Spotify client: read a stable mixed target and support minimal mutations. ------
replace_once(
    "src/services/spotify/client.ts",
    'import { readPlayableMusicCandidate } from "./music-availability";',
    'import { readPlayableMusicCandidate } from "./music-availability";\nimport { spotifyEpisodeIdFromUri } from "./podcast-listening-state";',
)

replace_once(
    "src/services/spotify/client.ts",
    "export interface PodcastCandidateBatch {\n  candidates: Candidate[];\n  playbackPositionMissingCount: number;\n  fullyPlayedSkippedCount: number;\n}\n",
    "export interface PodcastCandidateBatch {\n  candidates: Candidate[];\n  playbackPositionMissingCount: number;\n  fullyPlayedSkippedCount: number;\n}\n\nexport type SpotifyTargetPlaylistContentItem = {\n  position: number;\n  uri: string | null;\n  type: \"MUSIC\" | \"PODCAST\" | null;\n  title?: string;\n  subtitle?: string;\n  musicCandidate?: Candidate | null;\n  spotifyEpisodeId?: string | null;\n  programId?: string | null;\n  originalDurationMs?: number;\n  providerResumePositionMs?: number | null;\n  providerFullyPlayed?: boolean | null;\n  removableByUri: boolean;\n};\n\nexport type SpotifyTargetPlaylistState = {\n  snapshotId: string;\n  items: SpotifyTargetPlaylistContentItem[];\n};\n",
)

replace_once(
    "src/services/spotify/client.ts",
    "  async getCurrentUserId(): Promise<string> {",
    '''  /**
   * Reads the current mixed contents of a target playlist under one stable
   * snapshot. SCHEDULE-01 never treats a playlist that changed mid-read as a
   * complete source of truth.
   */
  async getTargetPlaylistState(playlistId: string): Promise<SpotifyTargetPlaylistState> {
    const snapshotBefore = await this.getPlaylistSnapshotId(playlistId);
    const items: SpotifyTargetPlaylistContentItem[] = [];
    let position = 0;
    let url: string | null =
      `/playlists/${playlistId}/items?market=from_token&additional_types=track,episode&limit=50&fields=next,items(item(id,uri,name,duration_ms,is_local,type,is_playable,restrictions(reason),linked_from(id),artists(id,name),album(id,name),show(id,name),resume_point(fully_played,resume_position_ms)))`;

    while (url) {
      const page: SpotifyPage<PlaylistItem> = await this.request(url);
      for (const wrapper of page.items) {
        const item = wrapper.item;
        if (!item) {
          items.push({ position, uri: null, type: null, removableByUri: false });
          position += 1;
          continue;
        }

        const uri = typeof item.uri === "string" && item.uri ? item.uri : null;
        if (item.type === "track") {
          const playable = readPlayableMusicCandidate(item);
          items.push({
            position,
            uri,
            type: "MUSIC",
            title: item.name,
            subtitle: playable.candidate?.subtitle,
            musicCandidate: playable.candidate,
            originalDurationMs: Math.max(0, item.duration_ms ?? 0),
            removableByUri: Boolean(uri),
          });
        } else if (item.type === "episode") {
          items.push({
            position,
            uri,
            type: "PODCAST",
            title: item.name,
            subtitle: item.show?.name,
            spotifyEpisodeId:
              item.id?.trim() || (uri ? spotifyEpisodeIdFromUri(uri) : null),
            programId: item.show?.id?.trim() || null,
            originalDurationMs: Math.max(0, item.duration_ms ?? 0),
            providerResumePositionMs:
              item.resume_point?.resume_position_ms == null
                ? null
                : Math.max(0, item.resume_point.resume_position_ms),
            providerFullyPlayed: item.resume_point?.fully_played ?? null,
            removableByUri: Boolean(uri),
          });
        } else {
          items.push({
            position,
            uri,
            type: null,
            title: item.name,
            originalDurationMs: Math.max(0, item.duration_ms ?? 0),
            removableByUri: Boolean(uri),
          });
        }
        position += 1;
      }
      url = page.next ? stripBase(page.next) : null;
    }

    const snapshotAfter = await this.getPlaylistSnapshotId(playlistId);
    if (snapshotAfter !== snapshotBefore) {
      throw new Error(
        `Spotify playlist ${playlistId} changed while its target contents were being read`,
      );
    }
    return { snapshotId: snapshotAfter, items };
  }

  async getCurrentUserId(): Promise<string> {''',
)

replace_once(
    "src/services/spotify/client.ts",
    '''  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
    const chunks = chunk(uris, 100);
    // First chunk (or an empty array) replaces everything.
    await this.request(`/playlists/${playlistId}/items`, {
      method: "PUT",
      body: JSON.stringify({ uris: chunks[0] ?? [] }),
    });
    for (const extra of chunks.slice(1)) {
      await this.request(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: extra }),
      });
    }
  }''',
    '''  async replacePlaylistItems(playlistId: string, uris: string[]): Promise<string | null> {
    const chunks = chunk(uris, 100);
    const first = await this.request<{ snapshot_id?: string }>(
      `/playlists/${playlistId}/items`,
      {
        method: "PUT",
        body: JSON.stringify({ uris: chunks[0] ?? [] }),
      },
    );
    let snapshot = first.snapshot_id ?? null;
    for (const extra of chunks.slice(1)) {
      const result = await this.request<{ snapshot_id?: string }>(
        `/playlists/${playlistId}/items`,
        {
          method: "POST",
          body: JSON.stringify({ uris: extra }),
        },
      );
      snapshot = result.snapshot_id ?? snapshot;
    }
    return snapshot;
  }

  /** Appends only the new deficit items; never reorders existing content. */
  async appendPlaylistItems(playlistId: string, uris: string[]): Promise<string | null> {
    let snapshot: string | null = null;
    for (const values of chunk(uris, 100)) {
      const result = await this.request<{ snapshot_id?: string }>(
        `/playlists/${playlistId}/items`,
        {
          method: "POST",
          body: JSON.stringify({ uris: values }),
        },
      );
      snapshot = result.snapshot_id ?? snapshot;
    }
    return snapshot;
  }

  /**
   * Removes occurrences by URI under Spotify's snapshot contract. This is used
   * only when KEEP_FILLED proved that each URI is unambiguous in the live target.
   */
  async removePlaylistItems(
    playlistId: string,
    uris: string[],
    snapshotId: string,
  ): Promise<string | null> {
    let snapshot: string | null = snapshotId;
    for (const values of chunk([...new Set(uris)], 100)) {
      const result = await this.request<{ snapshot_id?: string }>(
        `/playlists/${playlistId}/items`,
        {
          method: "DELETE",
          body: JSON.stringify({
            items: values.map((uri) => ({ uri })),
            snapshot_id: snapshot,
          }),
        },
      );
      snapshot = result.snapshot_id ?? snapshot;
    }
    return snapshot;
  }''',
)

replace_once(
    "src/services/spotify/client.ts",
    '''interface PlaylistContentResponse extends EpisodeResponse {
  is_local?: boolean;
  artists?: { name: string }[];
}''',
    '''interface PlaylistContentResponse extends EpisodeResponse {
  is_local?: boolean;
  linked_from?: { id?: string | null } | null;
  artists?: Array<{ id?: string | null; name?: string | null }>;
  album?: { id?: string | null; name?: string | null } | null;
}''',
)
replace_once(
    "src/services/spotify/client.ts",
    '''interface EpisodeResponse {
  uri: string;
  name: string;''',
    '''interface EpisodeResponse {
  id?: string;
  uri: string;
  name: string;''',
)

# Export new Spotify types.
replace_once(
    "src/services/spotify/index.ts",
    "  type SpotifyPlaylistSummary,\n  type SpotifyShowSummary,",
    "  type SpotifyPlaylistSummary,\n  type SpotifyShowSummary,\n  type SpotifyTargetPlaylistContentItem,\n  type SpotifyTargetPlaylistState,",
)

# ORDER-01 exposes the same canonical order hash after KEEP_FILLED recombines
# preserved items with newly randomized deficit items.
replace_once(
    "src/services/playlist-ordering.ts",
    "function finalOrderHash(items: OrderablePlaylistItem[]) {",
    "export function playlistOrderHash(items: OrderablePlaylistItem[]) {",
)
p = Path("src/services/playlist-ordering.ts")
p.write_text(p.read_text().replace("finalOrderHash(", "playlistOrderHash("))

# KEEP_FILLED orchestration preparation ----------------------------------------
Path("src/services/keep-filled-maintenance.ts").write_text(r'''import type { TargetPlaylist } from "@prisma/client";

import { resolveTargetDuration } from "@/jobs/generate-playlists-incremental";
import { prisma } from "@/lib/prisma";
import {
  buildKeepFilledPreservation,
  type GeneratedItemProvenance,
} from "@/services/keep-filled-core";
import type { Candidate } from "@/services/playlist-planner";
import { parseSequencePattern } from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";
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
  const podcastStates = await prismaPodcastListeningStateStore.observe(
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
''')

print("SCHEDULE-01 stage2 patch applied")
