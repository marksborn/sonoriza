import { prisma } from "@/lib/prisma";
import { previewUserDeclaredChapterDuration } from "./d6-self-reported-preview";
import {
  type SaveManualNotebookRequest,
} from "./d7-manual-notebook-contract";

export type ManualNotebookView = Readonly<{
  id: string;
  targetPlaylistId: string;
  revision: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  targetDurationMs: number;
  effectivePlanningDurationMs: number;
  remainingPlanningDurationMs: number;
  evidenceSource: "USER_DECLARED_UNVERIFIED";
  remoteChapterVerified: false;
  eligibleForBinding: false;
  eligibleForShadowPlanner: false;
  automaticPlaylistWritesAllowed: false;
  updatedAt: string;
}>;

export type ManualNotebookHistoryItem = Readonly<{
  revision: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  targetDurationMs: number;
  evidenceSource: "USER_DECLARED_UNVERIFIED";
  createdAt: string;
}>;

function fail(code: string): never { throw new Error("AUDIOBOOK_NOTEBOOK_" + code); }

function toView(row: {
  id: string; targetPlaylistId: string; revision: number;
  bookTitle: string; chapterLabel: string; chapterDurationMs: number;
  consumedMs: number; targetDurationMs: number; evidenceSource: string; updatedAt: Date;
}): ManualNotebookView {
  if (row.evidenceSource !== "USER_DECLARED_UNVERIFIED") fail("INVALID_PROVENANCE");
  return {
    id: row.id,
    targetPlaylistId: row.targetPlaylistId,
    revision: row.revision,
    bookTitle: row.bookTitle,
    chapterLabel: row.chapterLabel,
    chapterDurationMs: row.chapterDurationMs,
    consumedMs: row.consumedMs,
    targetDurationMs: row.targetDurationMs,
    effectivePlanningDurationMs: row.chapterDurationMs - row.consumedMs,
    remainingPlanningDurationMs: row.targetDurationMs -
      (row.chapterDurationMs - row.consumedMs),
    evidenceSource: "USER_DECLARED_UNVERIFIED",
    remoteChapterVerified: false,
    eligibleForBinding: false,
    eligibleForShadowPlanner: false,
    automaticPlaylistWritesAllowed: false,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Atomic revision-checked record+history write, owner-scoped and entirely DB
 * local. Never returns Spotify catalog IDs or a generation approval token.
 */
export async function saveUserDeclaredAudiobookNotebook(
  ownerId: string,
  input: SaveManualNotebookRequest,
): Promise<ManualNotebookView> {
  if (!ownerId) fail("OWNER_REQUIRED");
  return prisma.$transaction(async tx => {
    const target = await tx.targetPlaylist.findFirst({
      where: { id: input.targetPlaylistId, userId: ownerId },
      select: {
        id: true, durationMode: true, fixedDurationSeconds: true,
        spotifyPlaylistId: true, audiobookOverlay: { select: { id: true } },
      },
    });
    if (!target) fail("TARGET_NOT_FOUND");
    if (target.audiobookOverlay) fail("VERIFIED_OVERLAY_ALREADY_EXISTS");
    if (target.durationMode !== "FIXED" || !target.spotifyPlaylistId ||
        !/^[A-Za-z0-9]{22}$/.test(target.spotifyPlaylistId) ||
        !target.fixedDurationSeconds ||
        !Number.isSafeInteger(target.fixedDurationSeconds * 1000)) {
      fail("UNSUPPORTED_TARGET");
    }
    // Use the same durable per-playlist row lock as Spotify writer admission.
    // If a provider mutation started first, activeWrites prevents declaring
    // a protected notebook mid-flight. If this lock commits first, writer
    // admission rechecks notebook existence before any provider mutation.
    const fence = await tx.targetAudiobookWriteFence.upsert({
      where: { userId_spotifyPlaylistId: {
        userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId,
      } },
      create: { userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId },
      update: { updatedAt: new Date() },
    });
    if (fence.activeWrites !== 0 || fence.reviewRequired) {
      fail("WRITE_IN_FLIGHT_OR_UNCERTAIN");
    }
    const calculated = previewUserDeclaredChapterDuration({
      targetDurationMs: target.fixedDurationSeconds * 1000,
      bookTitle: input.bookTitle,
      chapterLabel: input.chapterLabel,
      chapterDurationMs: input.chapterDurationMs,
      selection: input.selection,
    });
    if (calculated.status !== "READY_MANUAL_PREVIEW") {
      fail("INVALID_DURATION_" + calculated.reason);
    }
    const current = await tx.targetAudiobookManualNotebook.findUnique({
      where: { userId_targetPlaylistId: {
        userId: ownerId, targetPlaylistId: target.id,
      } },
      select: { id: true, revision: true },
    });
    if (!current && input.expectedRevision !== 0) fail("REVISION_CONFLICT");
    if (current && current.revision !== input.expectedRevision) fail("REVISION_CONFLICT");

    const changes = {
      bookTitle: calculated.bookTitle,
      chapterLabel: calculated.chapterLabel,
      chapterDurationMs: calculated.declaredChapterDurationMs,
      consumedMs: calculated.declaredConsumedMs,
      targetDurationMs: calculated.targetDurationMs,
      evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
    };
    let saved;
    if (!current) {
      saved = await tx.targetAudiobookManualNotebook.create({
        data: {
          userId: ownerId, targetPlaylistId: target.id, revision: 1, ...changes,
        },
      });
    } else {
      const changed = await tx.targetAudiobookManualNotebook.updateMany({
        where: { id: current.id, userId: ownerId,
          targetPlaylistId: target.id, revision: input.expectedRevision },
        data: { ...changes, revision: { increment: 1 } },
      });
      if (changed.count !== 1) fail("REVISION_CONFLICT");
      saved = await tx.targetAudiobookManualNotebook.findUniqueOrThrow({
        where: { id: current.id },
      });
    }
    await tx.targetAudiobookManualEntry.create({
      data: {
        userId: ownerId, notebookId: saved.id, revision: saved.revision,
        ...changes,
      },
    });
    return toView(saved);
  });
}

/** Only reads the user's notebook; latest 50 revision snapshots, newest first. */
export async function readUserDeclaredAudiobookNotebook(
  ownerId: string,
  targetPlaylistId: string,
): Promise<Readonly<{
  notebook: ManualNotebookView | null;
  history: readonly ManualNotebookHistoryItem[];
}>> {
  if (!ownerId || !/^[A-Za-z0-9_-]{4,80}$/.test(targetPlaylistId)) fail("INVALID_TARGET");
  const current = await prisma.targetAudiobookManualNotebook.findFirst({
    where: { userId: ownerId, targetPlaylistId },
    include: { entries: { orderBy: { revision: "desc" }, take: 50 } },
  });
  if (!current) return { notebook: null, history: [] };
  if (current.evidenceSource !== "USER_DECLARED_UNVERIFIED" ||
      current.entries.some(e => e.evidenceSource !== "USER_DECLARED_UNVERIFIED")) {
    fail("INVALID_PROVENANCE");
  }
  return {
    notebook: toView(current),
    history: current.entries.map(e => ({
      revision: e.revision,
      bookTitle: e.bookTitle,
      chapterLabel: e.chapterLabel,
      chapterDurationMs: e.chapterDurationMs,
      consumedMs: e.consumedMs,
      targetDurationMs: e.targetDurationMs,
      evidenceSource: "USER_DECLARED_UNVERIFIED",
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/** Explicit deletion erases the whole notebook and its history, never Spotify. */
export async function deleteUserDeclaredAudiobookNotebook(
  ownerId: string,
  targetPlaylistId: string,
  expectedRevision: number,
): Promise<void> {
  if (!ownerId || !/^[A-Za-z0-9_-]{4,80}$/.test(targetPlaylistId) ||
      !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    fail("INVALID_DELETE_INPUT");
  }
  const outcome = await prisma.targetAudiobookManualNotebook.deleteMany({
    where: { userId: ownerId, targetPlaylistId, revision: expectedRevision },
  });
  if (outcome.count !== 1) fail("REVISION_CONFLICT");
}
