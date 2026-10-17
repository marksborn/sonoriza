/**
 * AUDIOBOOK-02 #489 Gate B.3 — authenticated service for explicit manual bind.
 * This code does NOT write any Spotify item or alter a playlist.
 */
import { prisma } from "@/lib/prisma";
import {
  calculateAudiobookVirtualDuration,
} from "./virtual-chapter-duration";
import {
  type ManualAudiobookBindRequest,
} from "./manual-bind-contract";
import { readSpotifyAudiobookChapterEvidence } from "./spotify-chapter-evidence";
import { withAudiobookOverlayBindAdmission } from "./write-admission-store";

export type ManualAudiobookBoundResult = Readonly<{
  targetPlaylistId: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  audiobookName: string;
  chapterName: string;
  chapterDurationMs: number;
  providerDurationMs: null;
  effectivePlanningDurationMs: number;
  remainingPlanningDurationMs: number;
  manualSpotifyControlRequired: true;
}>;

function fail(code: string): never {
  throw new Error(code);
}

export async function bindManualAudiobook(
  userId: string,
  input: ManualAudiobookBindRequest,
): Promise<ManualAudiobookBoundResult> {
  // Destination comes only from the authenticated user's persisted target.
  const target = await prisma.targetPlaylist.findFirst({
    where: { id: input.targetPlaylistId, userId },
    select: {
      spotifyPlaylistId: true,
      durationMode: true,
      fixedDurationSeconds: true,
    },
  });
  if (!target?.spotifyPlaylistId || !/^[A-Za-z0-9]{22}$/.test(target.spotifyPlaylistId)) {
    return fail("AUDIOBOOK_BIND_BLOCKED_TARGET_NOT_FOUND_OR_UNBOUND");
  }
  // Gate B.3 supports only explicitly configured fixed-duration destinations.
  // Calendar-derived budgets need a separate verified Gate C/D contract.
  if (
    target.durationMode !== "FIXED" ||
    typeof target.fixedDurationSeconds !== "number" ||
    !Number.isInteger(target.fixedDurationSeconds) ||
    target.fixedDurationSeconds <= 0
  ) {
    return fail("AUDIOBOOK_BIND_BLOCKED_FIXED_DURATION_REQUIRED");
  }

  // No fallback to item=null, an entered duration, or a guessed chapter URI.
  // These are GET-only Spotify operations, and a 403/429/404 aborts the bind.
  const evidence = await readSpotifyAudiobookChapterEvidence(
    userId,
    input.spotifyAudiobookId,
    input.selectedChapterId,
  );
  const planning = calculateAudiobookVirtualDuration({
    spotifyPlaylistId: target.spotifyPlaylistId,
    spotifyAudiobookId: evidence.spotifyAudiobookId,
    selectedChapterId: evidence.selectedChapterId,
    targetDurationMs: target.fixedDurationSeconds * 1_000,
    chapterDurationMs: evidence.chapterDurationMs,
    providerDurationMs: evidence.providerDurationMs,
    selection: input.selection,
  });
  if (planning.status !== "READY") {
    return fail(`AUDIOBOOK_BIND_BLOCKED_VIRTUAL_DURATION_${planning.reason}`);
  }

  // The callback is executed within the very same transaction that acquired
  // the destination's durable write fence. If there is an active/uncertain
  // write, a changed destination or a duplicate overlay, the INSERT aborts.
  await withAudiobookOverlayBindAdmission(
    {
      userId,
      targetPlaylistId: input.targetPlaylistId,
      spotifyPlaylistId: target.spotifyPlaylistId,
    },
    async tx => {
      const existing = await tx.targetAudiobookOverlay.findFirst({
        where: { userId, targetPlaylistId: input.targetPlaylistId },
        select: { id: true },
      });
      if (existing) return fail("AUDIOBOOK_BIND_BLOCKED_EXISTING_OVERLAY");
      await tx.targetAudiobookOverlay.create({
        data: {
          userId,
          targetPlaylistId: input.targetPlaylistId,
          spotifyPlaylistId: target.spotifyPlaylistId!,
          spotifyAudiobookId: evidence.spotifyAudiobookId,
          selectedChapterId: evidence.selectedChapterId,
          chapterDurationMs: evidence.chapterDurationMs,
          providerDurationMs: evidence.providerDurationMs,
          selectionMode: input.selection.mode,
          manualConsumedMs: planning.manualConsumedMs,
        },
      });
    },
  );

  return {
    targetPlaylistId: input.targetPlaylistId,
    spotifyPlaylistId: target.spotifyPlaylistId,
    spotifyAudiobookId: evidence.spotifyAudiobookId,
    selectedChapterId: evidence.selectedChapterId,
    audiobookName: evidence.audiobookName,
    chapterName: evidence.chapterName,
    chapterDurationMs: evidence.chapterDurationMs,
    providerDurationMs: null,
    effectivePlanningDurationMs: planning.effectivePlanningDurationMs,
    remainingPlanningDurationMs: planning.remainingPlanningDurationMs,
    manualSpotifyControlRequired: true,
  };
}
