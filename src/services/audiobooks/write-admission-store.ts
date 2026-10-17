/**
 * AUDIOBOOK-02 #489 Gate B.2: Prisma-backed durable destination write fence.
 *
 * No public binding endpoint is enabled here. When one is added, it MUST use
 * withAudiobookOverlayBindAdmission around the SAME transaction as the INSERT.
 *
 * Workflow:
 * 1. Writers atomically increment activeWrites while verifying no overlay.
 * 2. Writers invoke Spotify outside a DB transaction, then decrement.
 * 3. Binders lock the same row and reject activeWrites/reviewRequired.
 * No timing window exists between the writer's admission and its remote call.
 *
 * Unknown remote outcomes leave reviewRequired=true; never auto-expire fences.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  AudiobookWriteFenceKey,
  AudiobookWriteFenceStore,
} from "./write-admission";

export const prismaAudiobookWriteFenceStore: AudiobookWriteFenceStore = {
  async begin({ userId, spotifyPlaylistId }) {
    await prisma.$transaction(async (tx) => {
      // The upsert must update the existing row and hold its row lock until
      // the overlay lookup finishes, serializing against link creation.
      const fence = await tx.targetAudiobookWriteFence.upsert({
        where: { userId_spotifyPlaylistId: { userId, spotifyPlaylistId } },
        create: { userId, spotifyPlaylistId, activeWrites: 1 },
        update: { activeWrites: { increment: 1 } },
      });
      if (fence.reviewRequired) {
        throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_RECONCILIATION_REQUIRED");
      }
      const overlay = await tx.targetAudiobookOverlay.findUnique({
        where: { userId_spotifyPlaylistId: { userId, spotifyPlaylistId } },
        select: { id: true },
      });
      if (overlay) {
        throw new Error("AUDIOBOOK_PLAYLIST_WRITE_BLOCKED_PROTECTED_TARGET");
      }
    });
  },

  async finish({ userId, spotifyPlaylistId }, reviewRequired) {
    const result = await prisma.targetAudiobookWriteFence.updateMany({
      where: { userId, spotifyPlaylistId, activeWrites: { gt: 0 } },
      data: {
        activeWrites: { decrement: 1 },
        ...(reviewRequired ? { reviewRequired: true } : {}),
      },
    });
    if (result.count !== 1) {
      throw new Error("AUDIOBOOK_PLAYLIST_WRITE_FENCE_RELEASE_FAILED");
    }
  },
};

/**
 * DB-level admission for future explicit/manual bindings.
 *
 * The binding INSERT/UPDATE callback runs INSIDE the same transaction and
 * must also validate the catalog chapter and user confirmation in its caller.
 * No public API calls this yet; it is NOT permission to bind arbitrary IDs.
 */
export async function withAudiobookOverlayBindAdmission<T>(
  input: AudiobookWriteFenceKey & { targetPlaylistId: string },
  commit: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { userId, spotifyPlaylistId, targetPlaylistId } = input;
  if (!userId?.trim() || !spotifyPlaylistId?.trim() || !targetPlaylistId?.trim()) {
    throw new Error("AUDIOBOOK_BIND_BLOCKED_MISSING_IDENTITY");
  }
  return prisma.$transaction(async (tx) => {
    // An upsert with a genuine UPDATE obtains the same row lock as begin.
    const fence = await tx.targetAudiobookWriteFence.upsert({
      where: { userId_spotifyPlaylistId: { userId, spotifyPlaylistId } },
      create: { userId, spotifyPlaylistId },
      update: { updatedAt: new Date() },
    });
    if (fence.activeWrites !== 0 || fence.reviewRequired) {
      throw new Error("AUDIOBOOK_BIND_BLOCKED_WRITE_IN_FLIGHT_OR_UNCERTAIN");
    }
    const target = await tx.targetPlaylist.findFirst({
      where: { id: targetPlaylistId, userId, spotifyPlaylistId },
      select: { id: true },
    });
    if (!target) throw new Error("AUDIOBOOK_BIND_BLOCKED_TARGET_OWNERSHIP_OR_IDENTITY");
    return commit(tx);
  });
}

/**
 * Gate D.2: serialize edits of a destination configuration against both
 * an in-flight provider write and the creation of an audiobook overlay.
 *
 * All configuration writes must be inside the callback. Holding the same
 * fence row lock as withAudiobookOverlayBindAdmission means the two operations
 * cannot each pass the other's "no overlay"/"same target" check concurrently.
 * Config edits are deliberately BLOCKED for already bound destinations
 * (including innocuous rename) until a reviewed edit policy exists.
 *
 * Disabling a target is a separate, safe, no-playlist-write escape route.
 */
export async function withAudiobookTargetSettingsAdmission<T>(
  input: {
    userId: string;
    targetPlaylistId: string;
    expectedSpotifyPlaylistId: string | null;
  },
  commit: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { userId, targetPlaylistId, expectedSpotifyPlaylistId } = input;
  if (!userId?.trim() || !targetPlaylistId?.trim()) {
    throw new Error("AUDIOBOOK_TARGET_CONFIG_BLOCKED_MISSING_IDENTITY");
  }
  return prisma.$transaction(async tx => {
    if (expectedSpotifyPlaylistId) {
      const fence = await tx.targetAudiobookWriteFence.upsert({
        where: {
          userId_spotifyPlaylistId: {
            userId,
            spotifyPlaylistId: expectedSpotifyPlaylistId,
          },
        },
        create: { userId, spotifyPlaylistId: expectedSpotifyPlaylistId },
        update: { updatedAt: new Date() },
      });
      if (fence.activeWrites !== 0 || fence.reviewRequired) {
        throw new Error("AUDIOBOOK_TARGET_CONFIG_BLOCKED_REMOTE_WRITE_UNCERTAIN");
      }
    }
    const current = await tx.targetPlaylist.findFirst({
      where: {
        id: targetPlaylistId,
        userId,
        spotifyPlaylistId: expectedSpotifyPlaylistId,
      },
      select: { id: true },
    });
    if (!current) {
      throw new Error("AUDIOBOOK_TARGET_CONFIG_BLOCKED_STALE_OR_FOREIGN_TARGET");
    }
    const bound = await tx.targetAudiobookOverlay.findFirst({
      where: { userId, targetPlaylistId },
      select: { id: true },
    });
    if (bound) {
      throw new Error("AUDIOBOOK_TARGET_CONFIG_BLOCKED_PROTECTED_OVERLAY");
    }
    return commit(tx);
  });
}
