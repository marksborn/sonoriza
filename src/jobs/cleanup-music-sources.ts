import {
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { executeAutomaticMusicSourceCleanup } from "@/services/spotify/source-cleanup";

export type MusicSourceCleanupJobResult = {
  sourcePlaylistId: string;
  sourceName: string | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  removedTrackCount: number;
  error?: string;
};

/**
 * Periodic MUSIC-02 maintenance. Sources are eligible only after a first
 * manual cleanup has completed successfully and automation was explicitly
 * enabled. Existing/migrated sources therefore cannot be mutated by this job.
 */
export async function runMusicSourceCleanupJob(): Promise<MusicSourceCleanupJobResult[]> {
  const sources = await prisma.sourcePlaylist.findMany({
    where: {
      enabled: true,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
      musicRetentionMode: MusicSourceRetentionMode.REMOVE_AFTER_PLAYED,
      musicCleanupAutomationEnabled: true,
      musicCleanupFirstCompletedAt: { not: null },
    },
    select: {
      id: true,
      userId: true,
      name: true,
    },
    orderBy: [{ userId: "asc" }, { name: "asc" }],
  });

  const results: MusicSourceCleanupJobResult[] = [];

  for (const source of sources) {
    try {
      const result = await executeAutomaticMusicSourceCleanup(
        source.userId,
        source.id,
      );
      results.push({
        sourcePlaylistId: source.id,
        sourceName: source.name,
        status: result.status === "PARTIAL" ? "PARTIAL" : "SUCCESS",
        removedTrackCount: result.removedTrackCount,
      });
    } catch (error) {
      results.push({
        sourcePlaylistId: source.id,
        sourceName: source.name,
        status: "FAILED",
        removedTrackCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
