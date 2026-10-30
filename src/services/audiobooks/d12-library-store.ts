/**
 * D.12: exactly one user-global manual reading, reusable in many destinations.
 * All operations are local PostgreSQL transactions: NEVER call Spotify.
 * Link rows are durable write-protection markers, even after completion or
 * target configuration deletion. No unsafe unlink/release API exists.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { LibraryCommand } from "./d12-library-contract";

function fail(reason: string): never {
  throw new Error("AUDIOBOOK_LIBRARY_" + reason);
}
async function lockUser(tx: Prisma.TransactionClient, ownerId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${ownerId} FOR UPDATE
  `;
  if (rows.length !== 1) fail("OWNER_REQUIRED");
}

/** D.14: progress may be user-declared or read from Spotify's resume_point. */
export const LIBRARY_EVIDENCE_SOURCES = [
  "USER_DECLARED_UNVERIFIED",
  "SPOTIFY_RESUME_POINT",
] as const;
export type LibraryEvidenceSource = (typeof LIBRARY_EVIDENCE_SOURCES)[number];

function isLibraryEvidenceSource(value: string): value is LibraryEvidenceSource {
  return (LIBRARY_EVIDENCE_SOURCES as readonly string[]).includes(value);
}

function libraryEvidenceSource(value: string): LibraryEvidenceSource {
  return isLibraryEvidenceSource(value) ? value : "USER_DECLARED_UNVERIFIED";
}

const showUrl = (id: string) => "https://open.spotify.com/show/" + id;

export async function readMultiPlaylistLibrary(ownerId: string) {
  if (!ownerId) fail("OWNER_REQUIRED");
  const [current, completed, legacyCount] = await Promise.all([
    prisma.userAudiobookLibraryReading.findFirst({
      where: { userId: ownerId, completedAt: null },
      include: {
        entries: { orderBy: { revision: "desc" }, take: 50 },
        targets: { orderBy: { createdAt: "asc" } },
      },
    }),
    prisma.userAudiobookLibraryReading.findMany({
      where: { userId: ownerId, completedAt: { not: null } },
      orderBy: { completedAt: "desc" }, take: 20,
      include: { targets: { select: { targetName: true, spotifyPlaylistId: true } } },
    }),
    prisma.targetAudiobookManualNotebook.count({ where: { userId: ownerId } }),
  ]);
  return {
    current: current ? {
      id: current.id, bookTitle: current.bookTitle,
      spotifyShowUrl: showUrl(current.spotifyShowId),
      chapterLabel: current.chapterLabel,
      chapterDurationMs: current.chapterDurationMs, consumedMs: current.consumedMs,
      revision: current.revision,
      evidenceSource: libraryEvidenceSource(current.evidenceSource),
      targets: current.targets.map(t => ({
        targetPlaylistId: t.targetPlaylistId, targetName: t.targetName,
        spotifyPlaylistId: t.spotifyPlaylistId, createdAt: t.createdAt.toISOString(),
      })),
      history: current.entries.map(e => ({
        revision: e.revision, chapterLabel: e.chapterLabel,
        chapterDurationMs: e.chapterDurationMs, consumedMs: e.consumedMs,
        recordedAt: e.createdAt.toISOString(),
      })),
    } : null,
    completed: completed.map(r => ({
      id: r.id, bookTitle: r.bookTitle, spotifyShowUrl: showUrl(r.spotifyShowId),
      completedAt: r.completedAt?.toISOString(), finalRevision: r.revision,
      targetNames: r.targets.map(t => t.targetName),
    })),
    legacyReviewRequired: legacyCount > 0,
    providerVerified: false,
    spotifyWrites: false,
  };
}

export async function mutateMultiPlaylistLibrary(ownerId: string, command: LibraryCommand) {
  if (!ownerId) fail("OWNER_REQUIRED");
  return prisma.$transaction(async tx => {
    await lockUser(tx, ownerId);
    const current = await tx.userAudiobookLibraryReading.findFirst({
      where: { userId: ownerId, completedAt: null },
    });
    if (command.action === "START") {
      if (current) fail("COMPLETE_CURRENT_BOOK_FIRST");
      // Legacy notebooks encode one book per target. Never silently migrate
      // or interpret them as one globally current reading.
      const [notes, overlays] = await Promise.all([
        tx.targetAudiobookManualNotebook.count({ where: { userId: ownerId } }),
        tx.targetAudiobookOverlay.count({ where: { userId: ownerId } }),
      ]);
      if (notes || overlays) fail("LEGACY_REVIEW_REQUIRED");
      const book = await tx.userAudiobookLibraryReading.create({
        data: {
          userId: ownerId, bookTitle: command.bookTitle,
          spotifyShowId: command.spotifyShowId,
          chapterLabel: command.chapterLabel,
          chapterDurationMs: command.chapterDurationMs,
          consumedMs: command.consumedMs, revision: 1,
          evidenceSource: "USER_DECLARED_UNVERIFIED",
        },
      });
      await tx.userAudiobookLibraryEntry.create({
        data: {
          userId: ownerId, readingId: book.id, revision: 1,
          bookTitle: book.bookTitle, spotifyShowId: book.spotifyShowId,
          chapterLabel: book.chapterLabel,
          chapterDurationMs: book.chapterDurationMs, consumedMs: book.consumedMs,
          evidenceSource: "USER_DECLARED_UNVERIFIED",
        },
      });
      return { status: "CREATED_USER_DECLARED_BOOK" as const, revision: 1 };
    }

    if (!current || current.revision !== command.expectedRevision) {
      fail("ACTIVE_READING_OR_REVISION_CONFLICT");
    }
    if (!isLibraryEvidenceSource(current.evidenceSource)) {
      fail("INVALID_PROVENANCE");
    }

    if (command.action === "UPDATE") {
      const updated = await tx.userAudiobookLibraryReading.updateMany({
        where: { id: current.id, userId: ownerId, completedAt: null,
          revision: command.expectedRevision },
        data: { chapterLabel: command.chapterLabel,
          chapterDurationMs: command.chapterDurationMs,
          consumedMs: command.consumedMs, revision: { increment: 1 },
          // A manual correction always wins over the last Spotify reading.
          evidenceSource: "USER_DECLARED_UNVERIFIED" },
      });
      if (updated.count !== 1) fail("REVISION_CONFLICT");
      await tx.userAudiobookLibraryEntry.create({
        data: { userId: ownerId, readingId: current.id,
          revision: command.expectedRevision + 1,
          bookTitle: current.bookTitle, spotifyShowId: current.spotifyShowId,
          chapterLabel: command.chapterLabel,
          chapterDurationMs: command.chapterDurationMs,
          consumedMs: command.consumedMs,
          evidenceSource: "USER_DECLARED_UNVERIFIED" },
      });
      return { status: "CHAPTER_UPDATED_GLOBALLY" as const,
        revision: command.expectedRevision + 1 };
    }

    if (command.action === "ATTACH") {
      const target = await tx.targetPlaylist.findFirst({
        where: { id: command.targetPlaylistId, userId: ownerId },
        select: { id: true, name: true, spotifyPlaylistId: true },
      });
      if (!target || !target.spotifyPlaylistId ||
          !/^[A-Za-z0-9]{22}$/.test(target.spotifyPlaylistId)) {
        fail("TARGET_NOT_OWNED_OR_NO_SPOTIFY_PLAYLIST");
      }
      // Serialized against current/future Spotify writers and configuration
      // edits using the same durable remote ID fence. Does NOT add a Spotify item.
      const fence = await tx.targetAudiobookWriteFence.upsert({
        where: { userId_spotifyPlaylistId: {
          userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId } },
        create: { userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId },
        update: { updatedAt: new Date() },
      });
      if (fence.activeWrites !== 0 || fence.reviewRequired) {
        fail("REMOTE_WRITE_ACTIVE_OR_UNCERTAIN");
      }
      const stable = await tx.targetPlaylist.findFirst({
        where: { id: target.id, userId: ownerId,
          spotifyPlaylistId: target.spotifyPlaylistId },
        select: { id: true },
      });
      if (!stable) fail("TARGET_CHANGED_DURING_ADMISSION");

      const [verified, legacyNote, legacyArchived, otherAssignment] = await Promise.all([
        tx.targetAudiobookOverlay.findFirst({
          where: { userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId },
          select: { id: true },
        }),
        tx.targetAudiobookManualNotebook.findFirst({
          where: { userId: ownerId,
            target: { spotifyPlaylistId: target.spotifyPlaylistId } },
          select: { id: true },
        }),
        tx.userAudiobookCompletedReading.findFirst({
          where: { userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId },
          select: { id: true },
        }),
        tx.userAudiobookLibraryTarget.findFirst({
          where: { userId: ownerId, spotifyPlaylistId: target.spotifyPlaylistId },
          select: { readingId: true },
        }),
      ]);
      if (verified || legacyNote || legacyArchived) fail("LEGACY_TARGET_PROTECTED");
      if (otherAssignment?.readingId === current.id) {
        fail("ALREADY_ASSOCIATED");
      }
      if (otherAssignment) fail("PREVIOUS_BOOK_PRESENCE_NOT_VERIFIED_REMOVED");
      await tx.userAudiobookLibraryTarget.create({
        data: {
          userId: ownerId, readingId: current.id,
          targetPlaylistId: target.id,
          targetName: target.name.trim().slice(0, 120) || "Playlist",
          spotifyPlaylistId: target.spotifyPlaylistId,
        },
      });
      return { status: "PLAYLIST_ASSOCIATED_WITHOUT_SPOTIFY_WRITE" as const,
        spotifyPlaylistId: target.spotifyPlaylistId };
    }

    if (command.action === "COMPLETE") {
      // Keep reading + all immutable snapshots + every remote playlist marker.
      // No provider request, no implicit release of the writer fence.
      const entries = await tx.userAudiobookLibraryEntry.findMany({
        where: { userId: ownerId, readingId: current.id },
        orderBy: { revision: "asc" },
        select: { revision: true, evidenceSource: true,
          bookTitle: true, spotifyShowId: true },
      });
      if (entries.length !== current.revision ||
          entries.some((e, i) => e.revision !== i + 1 ||
            !isLibraryEvidenceSource(e.evidenceSource) ||
            e.bookTitle !== current.bookTitle ||
            e.spotifyShowId !== current.spotifyShowId)) {
        fail("HISTORY_REQUIRES_REVIEW");
      }
      const result = await tx.userAudiobookLibraryReading.updateMany({
        where: { id: current.id, userId: ownerId,
          completedAt: null, revision: command.expectedRevision },
        data: { completedAt: new Date() },
      });
      if (result.count !== 1) fail("REVISION_CONFLICT");
      return { status: "COMPLETED_WITH_HISTORY_AND_MARKERS" as const,
        revision: current.revision };
    }
    fail("UNSUPPORTED_OPERATION");
  });
}
