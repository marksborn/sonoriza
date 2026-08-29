import {
  ArtistAffinityEvidenceType,
  HistoryLikeActionSource,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getProbableLikeShadow } from "./probable-like";

export type ProbableLikeConfirmationResult = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  alreadyLiked: boolean;
  artistAffinityUpdated: boolean;
  providerWriteAttempted: false;
  providerWriteReason: "USER_LIBRARY_MODIFY_SCOPE_NOT_ENABLED";
};

/**
 * HISTORY-04 Gate 5 — explicit one-track LIKE from the History surface.
 *
 * The internal LIKE is authoritative and does not depend on Spotify writes.
 * We deliberately reuse LIKED-01's canonical LikedTrackPreference and artist
 * affinity tables so #184 and SOURCE-LIKED-01 see the same preference instead
 * of a parallel History-only state.
 *
 * The current OAuth grant has user-library-read, not user-library-modify, so
 * this gate does not attempt a provider write. HistoryLikeAction preserves the
 * exact product provenance while LikedTrackPreference continues using the
 * existing LIKED_TRACK_SYNC provenance contract.
 */
export async function confirmProbableLike(input: {
  userId: string;
  spotifyTrackId: string;
}): Promise<ProbableLikeConfirmationResult> {
  const existingPreference = await prisma.likedTrackPreference.findUnique({
    where: {
      userId_spotifyTrackId: {
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
      },
    },
  });

  if (existingPreference?.isLiked) {
    return {
      spotifyTrackId: existingPreference.spotifyTrackId,
      trackName: existingPreference.trackName ?? "Faixa curtida",
      artistName: existingPreference.primaryArtistName ?? "Artista",
      alreadyLiked: true,
      artistAffinityUpdated: Boolean(existingPreference.primaryArtistId),
      providerWriteAttempted: false,
      providerWriteReason: "USER_LIBRARY_MODIFY_SCOPE_NOT_ENABLED",
    };
  }

  const ranking = await getProbableLikeShadow(input.userId, { limit: 25 });
  const candidate = ranking.candidates.find(
    (item) => item.spotifyTrackId === input.spotifyTrackId,
  );
  if (!candidate) throw new ProbableLikeCandidateNotFoundError();

  const [eventWithArtist, latestEvent] = await Promise.all([
    prisma.trackListeningEvent.findFirst({
      where: {
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
        primaryArtistId: { not: null },
      },
      orderBy: [{ playedAt: "desc" }, { id: "desc" }],
      select: {
        spotifyUri: true,
        primaryArtistId: true,
        artistName: true,
        albumId: true,
        albumName: true,
      },
    }),
    prisma.trackListeningEvent.findFirst({
      where: {
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
      },
      orderBy: [{ playedAt: "desc" }, { id: "desc" }],
      select: {
        spotifyUri: true,
        primaryArtistId: true,
        artistName: true,
        albumId: true,
        albumName: true,
      },
    }),
  ]);

  const identityEvent = eventWithArtist ?? latestEvent;
  const primaryArtistId =
    identityEvent?.primaryArtistId ?? existingPreference?.primaryArtistId ?? null;
  const primaryArtistName =
    identityEvent?.artistName ??
    existingPreference?.primaryArtistName ??
    candidate.artistName;
  const spotifyUri =
    identityEvent?.spotifyUri ??
    existingPreference?.spotifyUri ??
    `spotify:track:${candidate.spotifyTrackId}`;
  const albumId = identityEvent?.albumId ?? existingPreference?.albumId ?? null;
  const albumName = identityEvent?.albumName ?? existingPreference?.albumName ?? null;
  const durationMs =
    candidate.knownTrackDurationMs ?? existingPreference?.durationMs ?? null;
  const availability =
    existingPreference?.availability ?? LikedTrackAvailability.AVAILABLE;
  const now = new Date();

  const artistAffinityUpdated = await prisma.$transaction(async (tx) => {
    await tx.likedTrackPreference.upsert({
      where: {
        userId_spotifyTrackId: {
          userId: input.userId,
          spotifyTrackId: candidate.spotifyTrackId,
        },
      },
      create: {
        userId: input.userId,
        spotifyTrackId: candidate.spotifyTrackId,
        spotifyUri,
        trackName: candidate.trackName,
        primaryArtistId,
        primaryArtistName,
        albumId,
        albumName,
        durationMs,
        addedAt: null,
        isLiked: true,
        availability,
        firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        firstObservedAt: now,
        lastObservedAt: now,
        unlikedAt: null,
      },
      update: {
        spotifyUri,
        trackName: candidate.trackName,
        primaryArtistId,
        primaryArtistName,
        albumId,
        albumName,
        durationMs,
        isLiked: true,
        availability,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastObservedAt: now,
        unlikedAt: null,
      },
    });

    const activeEvidence = await tx.artistAffinityEvidence.findMany({
      where: {
        userId: input.userId,
        spotifyTrackId: candidate.spotifyTrackId,
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      select: { id: true, spotifyArtistId: true },
    });

    const affectedArtistIds = new Set<string>();
    for (const evidence of activeEvidence) {
      if (evidence.spotifyArtistId === primaryArtistId) continue;
      affectedArtistIds.add(evidence.spotifyArtistId);
      await tx.artistAffinityEvidence.update({
        where: { id: evidence.id },
        data: {
          active: false,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastChangedAt: now,
          removedAt: now,
        },
      });
    }

    if (primaryArtistId) {
      affectedArtistIds.add(primaryArtistId);
      await tx.artistAffinityEvidence.upsert({
        where: {
          userId_type_spotifyTrackId_spotifyArtistId: {
            userId: input.userId,
            type: ArtistAffinityEvidenceType.LIKED_TRACK,
            spotifyTrackId: candidate.spotifyTrackId,
            spotifyArtistId: primaryArtistId,
          },
        },
        create: {
          userId: input.userId,
          spotifyTrackId: candidate.spotifyTrackId,
          spotifyArtistId: primaryArtistId,
          artistName: primaryArtistName,
          type: ArtistAffinityEvidenceType.LIKED_TRACK,
          active: true,
          firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          firstObservedAt: now,
          lastChangedAt: now,
          removedAt: null,
        },
        update: {
          artistName: primaryArtistName,
          active: true,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastChangedAt: now,
          removedAt: null,
        },
      });
    }

    for (const spotifyArtistId of affectedArtistIds) {
      const likedTrackCount = await tx.artistAffinityEvidence.count({
        where: {
          userId: input.userId,
          spotifyArtistId,
          type: ArtistAffinityEvidenceType.LIKED_TRACK,
          active: true,
        },
      });
      const artistName =
        spotifyArtistId === primaryArtistId ? primaryArtistName : undefined;

      await tx.artistAffinityState.upsert({
        where: {
          userId_spotifyArtistId: {
            userId: input.userId,
            spotifyArtistId,
          },
        },
        create: {
          userId: input.userId,
          spotifyArtistId,
          artistName: artistName ?? null,
          likedTrackCount,
          active: likedTrackCount > 0,
          firstObservedAt: now,
          lastChangedAt: now,
        },
        update: {
          ...(artistName ? { artistName } : {}),
          likedTrackCount,
          active: likedTrackCount > 0,
          lastChangedAt: now,
        },
      });
    }

    await tx.historyLikeAction.upsert({
      where: {
        userId_spotifyTrackId_source: {
          userId: input.userId,
          spotifyTrackId: candidate.spotifyTrackId,
          source: HistoryLikeActionSource.PROBABLE_LIKE,
        },
      },
      create: {
        userId: input.userId,
        spotifyTrackId: candidate.spotifyTrackId,
        source: HistoryLikeActionSource.PROBABLE_LIKE,
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        primaryArtistId,
        candidateScore: candidate.score,
        candidateReasons: candidate.reasons,
        artistAffinityUpdated: Boolean(primaryArtistId),
        providerWriteAttempted: false,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
        confirmCount: 1,
      },
      update: {
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        primaryArtistId,
        candidateScore: candidate.score,
        candidateReasons: candidate.reasons,
        artistAffinityUpdated: Boolean(primaryArtistId),
        providerWriteAttempted: false,
        lastConfirmedAt: now,
        confirmCount: { increment: 1 },
      },
    });

    return Boolean(primaryArtistId);
  });

  return {
    spotifyTrackId: candidate.spotifyTrackId,
    trackName: candidate.trackName,
    artistName: candidate.artistName,
    alreadyLiked: false,
    artistAffinityUpdated,
    providerWriteAttempted: false,
    providerWriteReason: "USER_LIBRARY_MODIFY_SCOPE_NOT_ENABLED",
  };
}

export class ProbableLikeCandidateNotFoundError extends Error {
  constructor() {
    super("A faixa não faz mais parte do ranking de provável curtida.");
    this.name = "ProbableLikeCandidateNotFoundError";
  }
}
