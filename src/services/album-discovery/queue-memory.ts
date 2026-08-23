import { prisma } from "@/lib/prisma";
import type { AlbumOpportunityCandidate } from "./opportunity";

export const ALBUM_QUEUE_MEMORY_POLICY = {
  version: "album-gate5-queued-memory-v1",
  identity: "USER_ID_PLUS_SPOTIFY_ALBUM_ID",
  persistedState: "QUEUED",
  rankingRule: "QUEUED_EXACT_EDITION_IS_SUPPRESSED_UNTIL_STATE_TRANSITIONS",
  reconciliation:
    "EXISTING_PLAYLIST_CONTENT_MAY_BE_RECONCILED_ONLY_AFTER_EXACT_EDITION_SEQUENCE_IS_OBSERVED",
} as const;

export type AlbumRecommendationMemoryState =
  | "DISCOVERED"
  | "RECOMMENDED"
  | "QUEUED"
  | "LISTENING"
  | "COMPLETED"
  | "DISMISSED";

export type QueuedAlbumMemoryInput = {
  userId: string;
  spotifyAlbumId: string;
  artistName: string;
  albumName: string;
  queuedAt?: Date;
  playlistId: string;
  playlistName: string;
  writerSnapshot: string | null;
  contentFingerprint: string;
  source: "CONTROLLED_QUEUE_WRITER" | "RECONCILED_EXISTING_PLAYLIST";
};

export type QueuedAlbumMemorySummary = {
  spotifyAlbumId: string;
  state: AlbumRecommendationMemoryState;
  queuedAt: Date | null;
};

export function suppressQueuedAlbumOpportunities(
  candidates: AlbumOpportunityCandidate[],
  memories: QueuedAlbumMemorySummary[],
): { candidates: AlbumOpportunityCandidate[]; suppressedAlbumIds: string[] } {
  const queuedIds = new Set(
    memories
      .filter((memory) => memory.state === "QUEUED")
      .map((memory) => memory.spotifyAlbumId),
  );
  const suppressedAlbumIds: string[] = [];
  const next = candidates.map((candidate) => {
    if (!queuedIds.has(candidate.spotifyAlbumId)) return candidate;
    suppressedAlbumIds.push(candidate.spotifyAlbumId);
    return {
      ...candidate,
      eligible: false,
      memoryState: "QUEUED" as const,
      reasons: [
        ...candidate.reasons,
        {
          code: "ALBUM_ALREADY_QUEUED" as const,
          detail: "exact Spotify album edition is persisted as QUEUED",
        },
      ],
    };
  });
  return { candidates: next, suppressedAlbumIds };
}

export async function loadAlbumRecommendationMemories(
  userId: string,
): Promise<QueuedAlbumMemorySummary[]> {
  return prisma.albumRecommendationMemory.findMany({
    where: { userId },
    select: {
      spotifyAlbumId: true,
      state: true,
      queuedAt: true,
    },
  });
}

export async function recordQueuedAlbumMemory(input: QueuedAlbumMemoryInput) {
  const queuedAt = input.queuedAt ?? new Date();
  return prisma.albumRecommendationMemory.upsert({
    where: {
      userId_spotifyAlbumId: {
        userId: input.userId,
        spotifyAlbumId: input.spotifyAlbumId,
      },
    },
    create: {
      userId: input.userId,
      spotifyAlbumId: input.spotifyAlbumId,
      state: "QUEUED",
      artistName: input.artistName,
      albumName: input.albumName,
      queuedAt,
      queuedPlaylistId: input.playlistId,
      queuedPlaylistName: input.playlistName,
      queuedWriterSnapshot: input.writerSnapshot,
      queuedContentFingerprint: input.contentFingerprint,
      source: input.source,
    },
    update: {
      state: "QUEUED",
      artistName: input.artistName,
      albumName: input.albumName,
      queuedAt,
      queuedPlaylistId: input.playlistId,
      queuedPlaylistName: input.playlistName,
      queuedWriterSnapshot: input.writerSnapshot,
      queuedContentFingerprint: input.contentFingerprint,
      source: input.source,
    },
  });
}
