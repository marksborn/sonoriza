import { prisma } from "@/lib/prisma";
import type { CompleteReadingRequest } from "./d9-completed-reading-contract";

function fail(reason: string): never {
  throw new Error("AUDIOBOOK_READING_" + reason);
}

/**
 * Finish a single manual book in one transaction:
 * - User row lock serializes starting/completing books on multiple devices;
 * - remote playlist fence disallows a completion during a Spotify write;
 * - all D.7 snapshots are copied, then the source notebook is removed;
 * - archived presence remains a permanent no-writes marker for that playlist.
 * No Spotify requests, provider identities inferred, or remote mutations.
 */
export async function completeManualReading(
  ownerId: string,
  input: CompleteReadingRequest,
) {
  if (!ownerId) fail("OWNER_REQUIRED");
  return prisma.$transaction(async tx => {
    const user = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE
    `;
    if (user.length !== 1) fail("OWNER_REQUIRED");

    const notes = await tx.targetAudiobookManualNotebook.findMany({
      where: { userId: ownerId },
      take: 2,
      include: {
        target: { select: { spotifyPlaylistId: true } },
        entries: { orderBy: { revision: "asc" } },
      },
    });
    if (notes.length !== 1) {
      fail(notes.length === 0 ? "NO_ACTIVE_BOOK" : "MULTIPLE_ACTIVE_BOOKS_REVIEW_REQUIRED");
    }
    const note = notes[0];
    if (!note) fail("NO_ACTIVE_BOOK");
    if (note.targetPlaylistId !== input.targetPlaylistId ||
        note.revision !== input.expectedRevision) fail("REVISION_CONFLICT");
    if (note.evidenceSource !== "USER_DECLARED_UNVERIFIED" ||
        !note.target.spotifyPlaylistId) fail("INVALID_PROVENANCE_OR_TARGET");

    // Never archive a legacy notebook containing silently switched books.
    if (note.entries.length !== note.revision ||
        note.entries.some((e, i) =>
          e.revision !== i + 1 || e.userId !== ownerId ||
          e.bookTitle !== note.bookTitle ||
          e.evidenceSource !== "USER_DECLARED_UNVERIFIED")) {
      fail("AMBIGUOUS_OR_INCOMPLETE_HISTORY_REVIEW_REQUIRED");
    }

    const spotifyPlaylistId = note.target.spotifyPlaylistId;
    const fence = await tx.targetAudiobookWriteFence.upsert({
      where: { userId_spotifyPlaylistId: {
        userId: ownerId, spotifyPlaylistId,
      } },
      create: { userId: ownerId, spotifyPlaylistId },
      update: { updatedAt: new Date() },
    });
    if (fence.activeWrites !== 0 || fence.reviewRequired) {
      fail("WRITE_IN_FLIGHT_OR_UNCERTAIN");
    }
    const archived = await tx.userAudiobookCompletedReading.create({
      data: {
        userId: ownerId,
        originalNotebookId: note.id,
        targetPlaylistId: note.targetPlaylistId,
        spotifyPlaylistId,
        bookTitle: note.bookTitle,
        finalRevision: note.revision,
        evidenceSource: "USER_DECLARED_UNVERIFIED",
        entries: {
          create: note.entries.map(e => ({
            revision: e.revision,
            bookTitle: e.bookTitle,
            chapterLabel: e.chapterLabel,
            chapterDurationMs: e.chapterDurationMs,
            consumedMs: e.consumedMs,
            targetDurationMs: e.targetDurationMs,
            evidenceSource: "USER_DECLARED_UNVERIFIED",
            recordedAt: e.createdAt,
          })),
        },
      },
      select: {
        id: true, bookTitle: true, finalRevision: true,
        completedAt: true, targetPlaylistId: true,
      },
    });
    const deleted = await tx.targetAudiobookManualNotebook.deleteMany({
      where: {
        id: note.id, userId: ownerId,
        revision: input.expectedRevision,
      },
    });
    if (deleted.count !== 1) fail("REVISION_CONFLICT");

    return {
      status: "COMPLETED_LOCAL_ARCHIVE_ONLY" as const,
      ...archived,
      completedAt: archived.completedAt.toISOString(),
      copiedChapters: note.entries.length,
      archivePreservesSpotifyProtection: true as const,
      spotifyWrites: false as const,
      remoteBookRemovalVerified: false as const,
    };
  });
}

export async function listCompletedManualReadings(ownerId: string) {
  if (!ownerId) fail("OWNER_REQUIRED");
  const rows = await prisma.userAudiobookCompletedReading.findMany({
    where: { userId: ownerId },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: {
      id: true, bookTitle: true, completedAt: true, finalRevision: true,
      targetPlaylistId: true, _count: { select: { entries: true } },
    },
  });
  return rows.map(row => ({
    id: row.id,
    bookTitle: row.bookTitle,
    completedAt: row.completedAt.toISOString(),
    finalRevision: row.finalRevision,
    targetPlaylistId: row.targetPlaylistId,
    chaptersRecorded: row._count.entries,
    evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
    spotifyWrites: false as const,
  }));
}

/** Complete, owner-scoped archived chapter history. Never changes Spotify. */
export async function readCompletedManualReading(ownerId: string, archiveId: string) {
  if (!ownerId || !/^[A-Za-z0-9_-]{4,80}$/.test(archiveId)) {
    fail("INVALID_ARCHIVE_ID");
  }
  const row = await prisma.userAudiobookCompletedReading.findFirst({
    where: { id: archiveId, userId: ownerId },
    include: { entries: { orderBy: { revision: "asc" } } },
  });
  if (!row) fail("ARCHIVE_NOT_FOUND");
  if (row.evidenceSource !== "USER_DECLARED_UNVERIFIED" ||
      row.entries.some(e => e.evidenceSource !== "USER_DECLARED_UNVERIFIED")) {
    fail("INVALID_ARCHIVE_PROVENANCE");
  }
  return {
    id: row.id,
    bookTitle: row.bookTitle,
    completedAt: row.completedAt.toISOString(),
    finalRevision: row.finalRevision,
    chapters: row.entries.map(e => ({
      revision: e.revision,
      chapterLabel: e.chapterLabel,
      chapterDurationMs: e.chapterDurationMs,
      consumedMs: e.consumedMs,
      recordedAt: e.recordedAt.toISOString(),
    })),
    evidenceSource: "USER_DECLARED_UNVERIFIED" as const,
    spotifyWrites: false as const,
  };
}
