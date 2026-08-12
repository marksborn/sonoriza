import {
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";

import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { dispatchMusicCleanupRunNotificationSafely } from "@/services/notifications";
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
 * AUTH-01 additionally excludes removed users before any Spotify mutation.
 */
export async function runMusicSourceCleanupJob(): Promise<MusicSourceCleanupJobResult[]> {
  const sources = (
    await prisma.sourcePlaylist.findMany({
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
        user: { select: { email: true } },
      },
      orderBy: [{ userId: "asc" }, { name: "asc" }],
    })
  ).filter((source) => isEmailAllowed(source.user.email));

  const results: MusicSourceCleanupJobResult[] = [];

  for (const source of sources) {
    const attemptStartedAt = new Date();
    try {
      const result = await executeAutomaticMusicSourceCleanup(
        source.userId,
        source.id,
      );
      await dispatchMusicCleanupRunNotificationSafely(result.runId);
      results.push({
        sourcePlaylistId: source.id,
        sourceName: source.name,
        status: result.status === "PARTIAL" ? "PARTIAL" : "SUCCESS",
        removedTrackCount: result.removedTrackCount,
      });
    } catch (error) {
      // Finding the optional failed audit exists only to send a push. Even a
      // database/read problem in this secondary path must not replace the
      // cleanup result that was already determined above.
      try {
        const failedAudit = await prisma.musicSourceCleanupRun.findFirst({
          where: {
            userId: source.userId,
            sourcePlaylistId: source.id,
            startedAt: { gte: attemptStartedAt },
            finishedAt: { not: null },
            status: { in: ["FAILED", "PARTIAL", "SUCCESS"] },
          },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        });
        if (failedAudit) {
          await dispatchMusicCleanupRunNotificationSafely(failedAudit.id);
        }
      } catch {
        // Notification lookup/delivery is intentionally best-effort.
      }

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
