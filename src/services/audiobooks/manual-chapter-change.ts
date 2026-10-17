/**
 * AUDIOBOOK-02 Gate C — local-only chapter switch for an existing overlay.
 * No Spotify writes, generation scheduling, chapter playback, or inference.
 */
import { prisma } from "@/lib/prisma";
import { calculateAudiobookVirtualDuration } from "./virtual-chapter-duration";
import { readSpotifyAudiobookChapterEvidence } from "./spotify-chapter-evidence";
import { withAudiobookOverlayBindAdmission } from "./write-admission-store";
import type { ManualChapterChangeInput } from "./manual-chapter-change-contract";

const PREFIX = "AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_";

function blocked(reason: string): never {
  throw new Error(PREFIX + reason);
}

export type ManualChapterChangePreview = Readonly<{
  status: "READY";
  targetPlaylistId: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  previousChapterId: string;
  selectedChapterId: string;
  audiobookName: string;
  chapterName: string;
  expectedRevision: number;
  chapterDurationMs: number;
  effectivePlanningDurationMs: number;
  remainingPlanningDurationMs: number;
  targetDurationMs: number;
  manualConsumedMs: number;
  manualSpotifyControlRequired: true;
}>;

async function evaluateChange(
  userId: string,
  input: ManualChapterChangeInput,
) {
  if (!userId?.trim()) blocked("NOT_AUTHORIZED");
  const overlay = await prisma.targetAudiobookOverlay.findFirst({
    where: { userId, targetPlaylistId: input.targetPlaylistId },
    select: {
      id: true,
      spotifyPlaylistId: true,
      spotifyAudiobookId: true,
      selectedChapterId: true,
      revision: true,
      target: { select: {
        spotifyPlaylistId: true,
        durationMode: true,
        fixedDurationSeconds: true,
      } },
    },
  });
  // The parent identity comes only from this stored, owner-scoped row.
  if (!overlay) blocked("NOT_FOUND");
  if (overlay.revision !== input.expectedRevision) blocked("STALE_REVISION");
  if (!overlay.target.spotifyPlaylistId ||
      overlay.target.spotifyPlaylistId !== overlay.spotifyPlaylistId) {
    blocked("DESTINATION_DRIFT");
  }
  if (overlay.target.durationMode !== "FIXED" ||
      typeof overlay.target.fixedDurationSeconds !== "number" ||
      !Number.isSafeInteger(overlay.target.fixedDurationSeconds) ||
      overlay.target.fixedDurationSeconds <= 0) {
    blocked("FIXED_DURATION_REQUIRED");
  }
  // A change must remain in the exact same audiobook. Only new chapter ID
  // is user-supplied; the catalogue verifies its owner via a GET.
  const evidence = await readSpotifyAudiobookChapterEvidence(
    userId,
    overlay.spotifyAudiobookId,
    input.selectedChapterId,
  );
  const plan = calculateAudiobookVirtualDuration({
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    selectedChapterId: input.selectedChapterId,
    targetDurationMs: overlay.target.fixedDurationSeconds * 1000,
    chapterDurationMs: evidence.chapterDurationMs,
    selection: input.selection,
  });
  if (plan.status !== "READY") blocked("DURATION_" + plan.reason);
  return { overlay, evidence, plan };
}

/** Read-only and ephemeral; must be recomputed before every local update. */
export async function previewManualChapterChange(
  userId: string,
  input: ManualChapterChangeInput,
): Promise<ManualChapterChangePreview> {
  const { overlay, evidence, plan } = await evaluateChange(userId, input);
  return {
    status: "READY",
    targetPlaylistId: input.targetPlaylistId,
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    previousChapterId: overlay.selectedChapterId,
    selectedChapterId: evidence.selectedChapterId,
    audiobookName: evidence.audiobookName,
    chapterName: evidence.chapterName,
    expectedRevision: overlay.revision,
    chapterDurationMs: evidence.chapterDurationMs,
    effectivePlanningDurationMs: plan.effectivePlanningDurationMs,
    remainingPlanningDurationMs: plan.remainingPlanningDurationMs,
    targetDurationMs: plan.targetDurationMs,
    manualConsumedMs: plan.manualConsumedMs,
    manualSpotifyControlRequired: true,
  };
}

export type ManualChapterChangeResult = Omit<ManualChapterChangePreview, "status"> & Readonly<{
  status: "UPDATED_LOCAL_ONLY";
  revision: number;
}>;

/**
 * The explicit confirmation route calls this after authenticating the user.
 * Transactional revision-CAS and audit prevent silent stale overwrites.
 */
export async function updateManualChapter(
  userId: string,
  input: ManualChapterChangeInput,
): Promise<ManualChapterChangeResult> {
  const { overlay, evidence, plan } = await evaluateChange(userId, input);
  const nextRevision = input.expectedRevision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > 2147483647) {
    blocked("REVISION_EXHAUSTED");
  }

  await withAudiobookOverlayBindAdmission({
    userId,
    targetPlaylistId: input.targetPlaylistId,
    spotifyPlaylistId: overlay.spotifyPlaylistId,
  }, async tx => {
    // Ensure the target budget did not change between catalogue validation
    // and the transaction. Target ID/remote destination were also checked by
    // withAudiobookOverlayBindAdmission within this transaction.
    const currentTarget = await tx.targetPlaylist.findFirst({
      where: { userId, id: input.targetPlaylistId,
        spotifyPlaylistId: overlay.spotifyPlaylistId,
        durationMode: "FIXED",
        fixedDurationSeconds: overlay.target.fixedDurationSeconds },
      select: { id: true },
    });
    if (!currentTarget) blocked("TARGET_CHANGED");
    const before = await tx.targetAudiobookOverlay.findFirst({
      where: {
        id: overlay.id,
        userId,
        targetPlaylistId: input.targetPlaylistId,
        spotifyPlaylistId: overlay.spotifyPlaylistId,
        spotifyAudiobookId: overlay.spotifyAudiobookId,
        revision: input.expectedRevision,
      },
      select: {
        selectedChapterId: true,
        selectionMode: true,
        manualConsumedMs: true,
      },
    });
    if (!before) blocked("STALE_REVISION");
    if (before.selectedChapterId === evidence.selectedChapterId &&
        before.selectionMode === input.selection.mode &&
        before.manualConsumedMs === plan.manualConsumedMs) {
      blocked("NO_CHANGE");
    }
    const result = await tx.targetAudiobookOverlay.updateMany({
      where: {
        id: overlay.id,
        userId,
        targetPlaylistId: input.targetPlaylistId,
        spotifyPlaylistId: overlay.spotifyPlaylistId,
        spotifyAudiobookId: overlay.spotifyAudiobookId,
        revision: input.expectedRevision,
      },
      data: {
        selectedChapterId: evidence.selectedChapterId,
        chapterDurationMs: evidence.chapterDurationMs,
        selectionMode: input.selection.mode,
        manualConsumedMs: plan.manualConsumedMs,
        revision: { increment: 1 },
      },
    });
    if (result.count !== 1) blocked("STALE_REVISION");
    await tx.targetAudiobookChapterChange.create({
      data: {
        userId,
        overlayId: overlay.id,
        targetPlaylistId: input.targetPlaylistId,
        previousChapterId: before.selectedChapterId,
        selectedChapterId: evidence.selectedChapterId,
        previousRevision: input.expectedRevision,
        revision: nextRevision,
        manualConsumedMs: plan.manualConsumedMs,
        chapterDurationMs: evidence.chapterDurationMs,
      },
    });
  });
  return {
    status: "UPDATED_LOCAL_ONLY",
    targetPlaylistId: input.targetPlaylistId,
    spotifyPlaylistId: overlay.spotifyPlaylistId,
    spotifyAudiobookId: overlay.spotifyAudiobookId,
    previousChapterId: overlay.selectedChapterId,
    selectedChapterId: evidence.selectedChapterId,
    audiobookName: evidence.audiobookName,
    chapterName: evidence.chapterName,
    expectedRevision: input.expectedRevision,
    revision: nextRevision,
    chapterDurationMs: evidence.chapterDurationMs,
    effectivePlanningDurationMs: plan.effectivePlanningDurationMs,
    remainingPlanningDurationMs: plan.remainingPlanningDurationMs,
    targetDurationMs: plan.targetDurationMs,
    manualConsumedMs: plan.manualConsumedMs,
    manualSpotifyControlRequired: true,
  };
}
