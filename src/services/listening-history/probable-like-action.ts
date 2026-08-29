import {
  ArtistAffinityEvidenceType,
  HistoryLikeActionSource,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { saveSpotifyTrackToLibrary } from "@/services/spotify/library";
import { getProbableLikeShadow } from "./probable-like";

export type ProbableLikeConfirmationResult = {
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  alreadyLiked: boolean;
  artistAffinityUpdated: boolean;
  providerWriteAttempted: boolean;
  providerWriteSucceeded: boolean;
  providerWriteReason: "SAVED_TO_SPOTIFY_LIBRARY" | "ALREADY_LIKED";
};

type SaveTrackToSpotify = (input: {
  userId: string;
  spotifyTrackId: string;
}) => Promise<void>;

/**
 * HISTORY-04 Gate 5 — explicit one-track LIKE from the History surface.
 *
 * Product success means the track is saved to Spotify's Music Library and then
 * materialized in Sonoriza's canonical LikedTrackPreference/artist-affinity
 * state. Provider write intentionally happens before the local transaction: if
 * Spotify rejects the action, the candidate remains visible and can be retried.
 * If the provider succeeds but the local transaction fails, the next LIKED-01
 * sync repairs the local canonical state from Spotify.
 */
export async function confirmProbableLike(
  input: {
    userId: string;
    spotifyTrackId: string;
  },
  dependencies: { saveTrackToSpotify?: SaveTrackToSpotify } = {},
): Promise<ProbableLikeConfirmationResult> {
  const saveTrackToSpotify =
    dependencies.saveTrackToSpotify ?? saveSpotifyTrackToLibrary;

  const existingPreference = await prisma.likedTrackPreference.findUnique({
    where: {
      userId_spotifyTrackId: {
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
      },
    },
  });

  if (existingPreference?.isLiked) {
    const historyAction = await prisma.historyLikeAction.findUnique({
      where: {
        userId_spotifyTrackId_source: {
          userId: input.userId,
          spotifyTrackId: input.spotifyTrackId,
          source: HistoryLikeActionSource.PROBABLE_LIKE,
        },
      },
      select: { id: true, providerWriteAttempted: true },
    });

    // Gate 5 originally allowed a Sonoriza-only LIKE. If such a legacy action
    // reaches this endpoint before provider reconciliation demotes it, finish
    // the user's original explicit intent by saving it to Spotify first. A
    // normal Spotify-originated liked track has no pending History action and
    // can return immediately without a redundant provider write.
    if (historyAction && !historyAction.providerWriteAttempted) {
      await saveTrackToSpotify({
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
      });
      const now = new Date();
      await prisma.historyLikeAction.update({
        where: { id: historyAction.id },
        data: {
          providerWriteAttempted: true,
          lastConfirmedAt: now,
          confirmCount: { increment: 1 },
        },
      });

      return {
        spotifyTrackId: existingPreference.spotifyTrackId,
        trackName: existingPreference.trackName ?? "Faixa curtida",
        artistName: existingPreference.primaryArtistName ?? "Artista",
        alreadyLiked: true,
        artistAffinityUpdated: Boolean(existingPreference.primaryArtistId),
        providerWriteAttempted: true,
        providerWriteSucceeded: true,
        providerWriteReason: "SAVED_TO_SPOTIFY_LIBRARY",
      };
    }

    return {
      spotifyTrackId: existingPreference.spotifyTrackId,
      trackName: existingPreference.trackName ?? "Faixa curtida",
      artistName: existingPreference.primaryArtistName ?? "Artista",
      alreadyLiked: true,
      artistAffinityUpdated: Boolean(existingPreference.primaryArtistId),
      providerWriteAttempted: false,
      providerWriteSucceeded: true,
      providerWriteReason: "ALREADY_LIKED",
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

  // Do not create a local-only success. The explicit action first saves the
  // track to Spotify. This call is idempotent on Spotify's Library endpoint.
  await saveTrackToSpotify({
    userId: input.userId,
    spotifyTrackId: candidate.spotifyTrackId,
  });

  const now = new Date();
  const artistAffinityUpdated = await prisma.$transaction(async (tx) => {
    // Read the current track evidence before mutating anything so we know every
    // artist whose aggregate may change. The advisory locks below serialize all
    // count/recompute work for the same user+artist, preventing two concurrent
    // likes by one artist from both writing a stale likedTrackCount=1.
    const activeEvidence = await tx.artistAffinityEvidence.findMany({
      where: {
        userId: input.userId,
        spotifyTrackId: candidate.spotifyTrackId,
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      select: { id: true, spotifyArtistId: true },
    });

    const affectedArtistIds = new Set<string>(
      activeEvidence.map((evidence) => evidence.spotifyArtistId),
    );
    if (primaryArtistId) affectedArtistIds.add(primaryArtistId);
    const orderedAffectedArtistIds = [...affectedArtistIds].sort();

    for (const spotifyArtistId of orderedAffectedArtistIds) {
      // Two-int transaction-scoped advisory lock. The volatile lock function
      // is executed inside a subquery while only an int is returned to Prisma;
      // Prisma cannot deserialize PostgreSQL's native `void` return type.
      await tx.$queryRaw<Array<{ acquired: number }>>`
        SELECT 1::int AS acquired
        FROM (
          SELECT pg_advisory_xact_lock(
            hashtext(${`history04-like:${input.userId}`}),
            hashtext(${spotifyArtistId})
          )
        ) AS lock_row
      `;
    }

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
        // `addedAt` is a provider watermark. A local post-response clock can
        // leap over unsynchronized Saved Tracks and make incremental sync skip
        // them permanently. Leave it unknown until Spotify reports added_at.
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
        addedAt: null,
        isLiked: true,
        availability,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastObservedAt: now,
        unlikedAt: null,
      },
    });

    for (const evidence of activeEvidence) {
      if (evidence.spotifyArtistId === primaryArtistId) continue;
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

    for (const spotifyArtistId of orderedAffectedArtistIds) {
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
        providerWriteAttempted: true,
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
        providerWriteAttempted: true,
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
    providerWriteAttempted: true,
    providerWriteSucceeded: true,
    providerWriteReason: "SAVED_TO_SPOTIFY_LIBRARY",
  };
}

export class ProbableLikeCandidateNotFoundError extends Error {
  constructor() {
    super("A faixa não faz mais parte do ranking de provável curtida.");
    this.name = "ProbableLikeCandidateNotFoundError";
  }
}
