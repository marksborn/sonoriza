/**
 * Read-only preview. The eventual POST /manual-bind re-verifies all evidence;
 * a preview is never authorization to bypass the durable write fence.
 */
import { prisma } from "@/lib/prisma";
import { calculateAudiobookVirtualDuration } from "./virtual-chapter-duration";
import type { ManualAudiobookBindRequest } from "./manual-bind-contract";
import { readSpotifyAudiobookChapterEvidence } from "./spotify-chapter-evidence";

export async function previewManualAudiobook(
  userId: string,
  input: ManualAudiobookBindRequest,
) {
  const target = await prisma.targetPlaylist.findFirst({
    where: { id: input.targetPlaylistId, userId },
    select: {
      name: true,
      spotifyPlaylistId: true,
      durationMode: true,
      fixedDurationSeconds: true,
    },
  });
  if (!target?.spotifyPlaylistId ||
    !/^[A-Za-z0-9]{22}$/.test(target.spotifyPlaylistId)) {
    throw new Error("AUDIOBOOK_PREVIEW_TARGET_NOT_FOUND");
  }
  if (target.durationMode !== "FIXED" ||
    typeof target.fixedDurationSeconds !== "number" ||
    !Number.isInteger(target.fixedDurationSeconds) ||
    target.fixedDurationSeconds <= 0) {
    throw new Error("AUDIOBOOK_PREVIEW_FIXED_TARGET_REQUIRED");
  }

  const existing = await prisma.targetAudiobookOverlay.findUnique({
    where: { userId_spotifyPlaylistId: {
      userId, spotifyPlaylistId: target.spotifyPlaylistId,
    } },
    select: { id: true },
  });
  if (existing) throw new Error("AUDIOBOOK_PREVIEW_ALREADY_LINKED");

  const chapter = await readSpotifyAudiobookChapterEvidence(
    userId,
    input.spotifyAudiobookId,
    input.selectedChapterId,
  );
  const targetDurationMs = target.fixedDurationSeconds * 1000;
  const result = calculateAudiobookVirtualDuration({
    spotifyPlaylistId: target.spotifyPlaylistId,
    spotifyAudiobookId: chapter.spotifyAudiobookId,
    selectedChapterId: chapter.selectedChapterId,
    targetDurationMs,
    chapterDurationMs: chapter.chapterDurationMs,
    providerDurationMs: null,
    selection: input.selection,
  });
  if (result.status !== "READY") {
    throw new Error("AUDIOBOOK_PREVIEW_" + result.reason);
  }
  return {
    targetName: target.name,
    audiobookName: chapter.audiobookName,
    chapterName: chapter.chapterName,
    ...result,
    // Important: the source playlist's opaque audiobook object is not verifiable
    // via /playlists/{id}/items. Its presence must be confirmed by the user.
    manualBookPresenceConfirmationRequired: true as const,
  };
}
