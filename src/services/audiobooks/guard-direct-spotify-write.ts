/**
 * AUDIOBOOK-02 Gate B.2 (#489)
 * Guard for legacy Spotify writer services that use their own HTTP transport.
 * Retains existing HTTP response/retry handling inside execute().
 */
import { prisma } from "@/lib/prisma";
import {
  assertAudiobookPlaylistMutationAllowed,
  parseSpotifyPlaylistItemsMutation,
  type AudiobookPlaylistWriteRequest,
} from "./playlist-write-guard";
import { withAudiobookWriteAdmission } from "./write-admission";
import { prismaAudiobookWriteFenceStore } from "./write-admission-store";

export async function guardedSpotifyPlaylistWrite<T>(
  request: AudiobookPlaylistWriteRequest,
  execute: () => Promise<T>,
): Promise<T> {
  await assertAudiobookPlaylistMutationAllowed(
    request,
    async (userId, spotifyPlaylistId) =>
      (await prisma.targetAudiobookOverlay.findUnique({
        where: { userId_spotifyPlaylistId: { userId, spotifyPlaylistId } },
        select: { id: true },
      })) !== null,
  );
  if (
    process.env.AUDIOBOOK02_WRITE_FENCE_MODE === "ACTIVE" &&
    parseSpotifyPlaylistItemsMutation(request.path, request.method)
  ) {
    return withAudiobookWriteAdmission(request, prismaAudiobookWriteFenceStore, execute);
  }
  return execute();
}
