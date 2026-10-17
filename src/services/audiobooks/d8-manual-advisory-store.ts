import { prisma } from "@/lib/prisma";
import {
  projectUserDeclaredAudiobookAdvisory,
  type ManualAdvisoryResult,
} from "./d8-manual-advisory-shadow";

/**
 * D.8: fetch a SINGLE owner-scoped snapshot for read-only advisory projection.
 * No Spotify access; does not write to DB, logs, planner or GenerationRun.
 * A changed revision fails closed rather than silently taking a newer note.
 */
export async function readManualAdvisoryForOwner(input: Readonly<{
  ownerId: string;
  targetPlaylistId: string;
  expectedRevision: number;
  sampleMusicDurationsMs: readonly number[];
  samplePodcastDurationsMs: readonly number[];
}>): Promise<ManualAdvisoryResult | null> {
  if (!input.ownerId?.trim() ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(input.targetPlaylistId)) return null;
  const notebook = await prisma.targetAudiobookManualNotebook.findFirst({
    where: {
      targetPlaylistId: input.targetPlaylistId,
      userId: input.ownerId,
    },
    include: {
      target: {
        select: {
          id: true, userId: true, spotifyPlaylistId: true,
          durationMode: true, fixedDurationSeconds: true,
          compositionMode: true, updatePolicy: true, podcastPercent: true,
          audiobookOverlay: { select: { id: true } },
        },
      },
    },
  });
  if (!notebook) return null;
  return projectUserDeclaredAudiobookAdvisory({
    ownerId: input.ownerId,
    expectedRevision: input.expectedRevision,
    notebook,
    target: {
      ...notebook.target,
      hasVerifiedOverlay: notebook.target.audiobookOverlay !== null,
    },
    sampleMusicDurationsMs: input.sampleMusicDurationsMs,
    samplePodcastDurationsMs: input.samplePodcastDurationsMs,
  });
}
