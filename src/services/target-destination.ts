import { SpotifySourceType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type TargetDestinationConflictCode =
  | "source-conflict"
  | "target-conflict";

export class TargetDestinationConflictError extends Error {
  constructor(readonly code: TargetDestinationConflictCode) {
    super(code);
    this.name = "TargetDestinationConflictError";
  }
}

export async function assertTargetDestinationAvailableForUser(input: {
  userId: string;
  spotifyPlaylistId: string;
  targetId?: string;
}) {
  const [sourceConflict, targetConflict] = await Promise.all([
    prisma.sourcePlaylist.count({
      where: {
        userId: input.userId,
        spotifyType: SpotifySourceType.PLAYLIST,
        spotifyId: input.spotifyPlaylistId,
      },
    }),
    prisma.targetPlaylist.count({
      where: {
        userId: input.userId,
        spotifyPlaylistId: input.spotifyPlaylistId,
        ...(input.targetId
          ? { id: { not: input.targetId } }
          : {}),
      },
    }),
  ]);

  if (sourceConflict > 0) {
    throw new TargetDestinationConflictError(
      "source-conflict",
    );
  }

  if (targetConflict > 0) {
    throw new TargetDestinationConflictError(
      "target-conflict",
    );
  }
}
