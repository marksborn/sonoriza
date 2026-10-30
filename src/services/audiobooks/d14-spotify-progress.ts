import { prisma } from "@/lib/prisma";
import type { AudiobookChapterResponse } from "@/services/spotify/client";

/**
 * AUDIOBOOK-02 D.14 (#489): the active library reading follows Spotify's
 * per-chapter resume_point instead of manual input. Validated read-only on
 * 30/10/2026: one GET /audiobooks/{id}/chapters returns every chapter with
 * fully_played/resume_position_ms.
 *
 * Current chapter = first chapter (in book order) not fully played; progress
 * = its resume_position_ms. Opt-in with AUDIOBOOK02_SPOTIFY_PROGRESS_SYNC=ACTIVE.
 * Never fails a generation: on any error the last stored values are kept.
 * A manual update in the library always wins until the next sync.
 */

export type InferredChapter = Readonly<{
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
}>;

export function audiobookProgressSyncEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.AUDIOBOOK02_SPOTIFY_PROGRESS_SYNC?.trim() === "ACTIVE";
}

/** Null when no chapter carries a resume_point or the whole book was played. */
export function inferCurrentChapter(
  chapters: readonly AudiobookChapterResponse[],
): InferredChapter | null {
  if (!chapters.some((chapter) => chapter.resume_point)) return null;
  const index = chapters.findIndex(
    (chapter) => chapter.resume_point && chapter.resume_point.fully_played !== true,
  );
  if (index < 0) return null;
  const chapter = chapters[index]!;
  const durationMs = Math.trunc(chapter.duration_ms ?? 0);
  if (durationMs <= 0 || durationMs > 86_400_000) return null;
  const resume = Math.trunc(chapter.resume_point?.resume_position_ms ?? 0);
  // "Capítulo 1" repeats in every part: the book position disambiguates.
  const label = `${index + 1}. ${(chapter.name ?? "Capítulo").trim()}`.slice(0, 120);
  return {
    chapterLabel: label,
    chapterDurationMs: durationMs,
    consumedMs: Math.min(Math.max(0, resume), durationMs - 1),
  };
}

export type ProgressSyncEvidence = Readonly<{
  status: "UPDATED" | "UNCHANGED" | "NO_ACTIVE_READING" | "NOT_INFERABLE" | "FAILED";
  revision?: number;
  chapterLabel?: string;
  consumedMs?: number;
  error?: string;
}>;

export async function syncActiveReadingFromSpotify(input: {
  userId: string;
  /** Only readings linked to one of these playlists are synced. */
  spotifyPlaylistIds: readonly string[];
  readChapters: (audiobookId: string) => Promise<AudiobookChapterResponse[]>;
}): Promise<ProgressSyncEvidence> {
  try {
    const reading = await prisma.userAudiobookLibraryReading.findFirst({
      where: {
        userId: input.userId,
        completedAt: null,
        targets: { some: { spotifyPlaylistId: { in: [...input.spotifyPlaylistIds] } } },
      },
      select: {
        id: true, revision: true, bookTitle: true, spotifyShowId: true,
        chapterLabel: true, chapterDurationMs: true, consumedMs: true,
      },
    });
    if (!reading) return { status: "NO_ACTIVE_READING" };

    const inferred = inferCurrentChapter(await input.readChapters(reading.spotifyShowId));
    if (!inferred) return { status: "NOT_INFERABLE" };
    if (
      inferred.chapterLabel === reading.chapterLabel &&
      inferred.chapterDurationMs === reading.chapterDurationMs &&
      inferred.consumedMs === reading.consumedMs
    ) {
      return { status: "UNCHANGED", revision: reading.revision };
    }

    const revision = reading.revision + 1;
    await prisma.$transaction(async (tx) => {
      // Same CAS contract as a manual UPDATE: a concurrent edit wins.
      const updated = await tx.userAudiobookLibraryReading.updateMany({
        where: {
          id: reading.id, userId: input.userId, completedAt: null,
          revision: reading.revision,
        },
        data: { ...inferred, revision, evidenceSource: "SPOTIFY_RESUME_POINT" },
      });
      if (updated.count !== 1) throw new Error("AUDIOBOOK_LIBRARY_REVISION_CONFLICT");
      await tx.userAudiobookLibraryEntry.create({
        data: {
          userId: input.userId, readingId: reading.id, revision,
          bookTitle: reading.bookTitle, spotifyShowId: reading.spotifyShowId,
          ...inferred,
          evidenceSource: "SPOTIFY_RESUME_POINT",
        },
      });
    });
    return {
      status: "UPDATED",
      revision,
      chapterLabel: inferred.chapterLabel,
      consumedMs: inferred.consumedMs,
    };
  } catch (error) {
    return {
      status: "FAILED",
      error: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN",
    };
  }
}
