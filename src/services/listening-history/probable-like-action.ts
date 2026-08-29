import {
  ArtistAffinityEvidenceType,
  HistoryLikeActionSource,
  LikedTrackAvailability,
  LikedTrackPreferenceProvenance,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { saveSpotifyTrackToLibrary } from "@/services/spotify/library";
import { getProbableLikeShadow } from "./probable-like";
import {
  resolveProbableLikeSpotifyIdentity,
  type HistoricalSpotifyTrackFallbackEvidence,
  type ResolvedProbableLikeSpotifyIdentity,
} from "./probable-like-spotify-identity";

export type ProbableLikeConfirmationResult = {
  historicalSpotifyTrackId: string;
  spotifyTrackId: string;
  trackName: string;
  artistName: string;
  identityResolution: ResolvedProbableLikeSpotifyIdentity["resolution"] | "UNCHANGED_ALREADY_LIKED";
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

type ResolveSpotifyIdentity = (input: {
  userId: string;
  historicalSpotifyTrackId: string;
  fallbackEvidence?: HistoricalSpotifyTrackFallbackEvidence;
}) => Promise<ResolvedProbableLikeSpotifyIdentity>;

/**
 * HISTORY-04 Gate 5 — explicit one-track LIKE from the History surface.
 *
 * Historical listening events remain immutable evidence. Before opening or
 * liking, the current Spotify catalog identity is resolved from strong local
 * evidence (ISRC when available, otherwise exact track/artist/album matching).
 * Product success means the current Spotify track is saved first and only then
 * materialized in Sonoriza's canonical liked-track/artist-affinity state.
 */
export async function confirmProbableLike(
  input: {
    userId: string;
    spotifyTrackId: string;
  },
  dependencies: {
    saveTrackToSpotify?: SaveTrackToSpotify;
    resolveSpotifyIdentity?: ResolveSpotifyIdentity;
  } = {},
): Promise<ProbableLikeConfirmationResult> {
  const saveTrackToSpotify =
    dependencies.saveTrackToSpotify ?? saveSpotifyTrackToLibrary;
  const resolveSpotifyIdentity =
    dependencies.resolveSpotifyIdentity ?? resolveProbableLikeSpotifyIdentity;

  const [historicalPreference, historyAction] = await Promise.all([
    prisma.likedTrackPreference.findUnique({
      where: {
        userId_spotifyTrackId: {
          userId: input.userId,
          spotifyTrackId: input.spotifyTrackId,
        },
      },
    }),
    prisma.historyLikeAction.findUnique({
      where: {
        userId_spotifyTrackId_source: {
          userId: input.userId,
          spotifyTrackId: input.spotifyTrackId,
          source: HistoryLikeActionSource.PROBABLE_LIKE,
        },
      },
    }),
  ]);

  // A provider-originated current ID needs no catalog lookup or redundant PUT.
  // A legacy Gate 5 action with providerWriteAttempted=false is deliberately
  // not returned here: it still needs to be resolved/backfilled to Spotify.
  if (
    historicalPreference?.isLiked &&
    (!historyAction || historyAction.providerWriteAttempted)
  ) {
    return {
      historicalSpotifyTrackId: input.spotifyTrackId,
      spotifyTrackId: historicalPreference.spotifyTrackId,
      trackName: historicalPreference.trackName ?? "Faixa curtida",
      artistName: historicalPreference.primaryArtistName ?? "Artista",
      identityResolution: "UNCHANGED_ALREADY_LIKED",
      alreadyLiked: true,
      artistAffinityUpdated: Boolean(historicalPreference.primaryArtistId),
      providerWriteAttempted: false,
      providerWriteSucceeded: true,
      providerWriteReason: "ALREADY_LIKED",
    };
  }

  const ranking = await getProbableLikeShadow(input.userId, { limit: 25 });
  const candidate = ranking.candidates.find(
    (item) => item.spotifyTrackId === input.spotifyTrackId,
  );
  const pendingLegacyConfirmation = Boolean(
    historicalPreference?.isLiked &&
      historyAction &&
      !historyAction.providerWriteAttempted,
  );

  if (!candidate && !pendingLegacyConfirmation) {
    throw new ProbableLikeCandidateNotFoundError();
  }

  const snapshot = candidate
    ? {
        trackName: candidate.trackName,
        artistName: candidate.artistName,
        score: candidate.score,
        reasons: candidate.reasons,
        knownTrackDurationMs: candidate.knownTrackDurationMs,
      }
    : {
        trackName: historyAction!.trackName,
        artistName: historyAction!.artistName,
        score: historyAction!.candidateScore,
        reasons: readStringArray(historyAction!.candidateReasons),
        knownTrackDurationMs: historicalPreference?.durationMs ?? null,
      };

  const resolved = await resolveSpotifyIdentity({
    userId: input.userId,
    historicalSpotifyTrackId: input.spotifyTrackId,
    fallbackEvidence: {
      trackName: snapshot.trackName,
      artistName: snapshot.artistName,
      primaryArtistId:
        historicalPreference?.primaryArtistId ?? historyAction?.primaryArtistId ?? null,
      albumName: historicalPreference?.albumName ?? null,
      isrc: null,
    },
  });

  const currentPreference =
    resolved.spotifyTrackId === input.spotifyTrackId
      ? historicalPreference
      : await prisma.likedTrackPreference.findUnique({
          where: {
            userId_spotifyTrackId: {
              userId: input.userId,
              spotifyTrackId: resolved.spotifyTrackId,
            },
          },
        });

  // If reconciliation has already observed the resolved current ID, the user
  // intent is fulfilled. Canonicalize away an obsolete historical preference
  // before marking a pending legacy action complete, so one recording cannot
  // remain represented by two active canonical likes/affinity evidences.
  if (
    currentPreference?.isLiked &&
    !(pendingLegacyConfirmation && resolved.spotifyTrackId === input.spotifyTrackId)
  ) {
    if (
      historicalPreference?.isLiked &&
      resolved.spotifyTrackId !== input.spotifyTrackId
    ) {
      await canonicalizeAlreadyLikedRelink({
        userId: input.userId,
        historicalSpotifyTrackId: input.spotifyTrackId,
        currentSpotifyTrackId: resolved.spotifyTrackId,
        currentSpotifyArtistId: currentPreference.primaryArtistId,
        currentArtistName:
          currentPreference.primaryArtistName ?? resolved.primaryArtistName,
      });
    }

    if (historyAction && !historyAction.providerWriteAttempted) {
      await prisma.historyLikeAction.update({
        where: { id: historyAction.id },
        data: {
          providerWriteAttempted: true,
          lastConfirmedAt: new Date(),
          confirmCount: { increment: 1 },
        },
      });
    }

    return {
      historicalSpotifyTrackId: input.spotifyTrackId,
      spotifyTrackId: currentPreference.spotifyTrackId,
      trackName: currentPreference.trackName ?? resolved.trackName,
      artistName:
        currentPreference.primaryArtistName ?? resolved.primaryArtistName,
      identityResolution: resolved.resolution,
      alreadyLiked: true,
      artistAffinityUpdated: Boolean(currentPreference.primaryArtistId),
      providerWriteAttempted: false,
      providerWriteSucceeded: true,
      providerWriteReason: "ALREADY_LIKED",
    };
  }

  // Never create a local-only success. The current resolved Spotify recording
  // is saved first. If the provider rejects it, the historical candidate stays
  // visible and no canonical Sonoriza preference is materialized.
  await saveTrackToSpotify({
    userId: input.userId,
    spotifyTrackId: resolved.spotifyTrackId,
  });

  const now = new Date();
  const historicalTrackId = input.spotifyTrackId;
  const currentTrackId = resolved.spotifyTrackId;
  const durationMs =
    resolved.durationMs > 0
      ? resolved.durationMs
      : snapshot.knownTrackDurationMs ?? currentPreference?.durationMs ?? null;
  const availability =
    currentPreference?.availability ?? LikedTrackAvailability.AVAILABLE;

  const artistAffinityUpdated = await prisma.$transaction(async (tx) => {
    const trackIds =
      historicalTrackId === currentTrackId
        ? [currentTrackId]
        : [historicalTrackId, currentTrackId];

    const activeEvidence = await tx.artistAffinityEvidence.findMany({
      where: {
        userId: input.userId,
        spotifyTrackId: { in: trackIds },
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      select: { id: true, spotifyTrackId: true, spotifyArtistId: true },
    });

    const affectedArtistIds = new Set<string>(
      activeEvidence.map((evidence) => evidence.spotifyArtistId),
    );
    affectedArtistIds.add(resolved.primaryArtistId);
    const orderedAffectedArtistIds = [...affectedArtistIds].sort();

    for (const spotifyArtistId of orderedAffectedArtistIds) {
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

    // A historical ID can become obsolete/relinked. Preserve its listening
    // events, but do not keep a second active canonical LIKE beside the current
    // Spotify identity.
    if (historicalTrackId !== currentTrackId) {
      await tx.likedTrackPreference.updateMany({
        where: {
          userId: input.userId,
          spotifyTrackId: historicalTrackId,
          isLiked: true,
        },
        data: {
          isLiked: false,
          lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
          lastObservedAt: now,
          unlikedAt: now,
        },
      });
    }

    await tx.likedTrackPreference.upsert({
      where: {
        userId_spotifyTrackId: {
          userId: input.userId,
          spotifyTrackId: currentTrackId,
        },
      },
      create: {
        userId: input.userId,
        spotifyTrackId: currentTrackId,
        spotifyUri: resolved.spotifyUri,
        trackName: resolved.trackName,
        primaryArtistId: resolved.primaryArtistId,
        primaryArtistName: resolved.primaryArtistName,
        albumId: resolved.albumId,
        albumName: resolved.albumName,
        durationMs,
        // `addedAt` remains a provider watermark. The Spotify Library write
        // does not return added_at; reconciliation will fill it authoritatively.
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
        spotifyUri: resolved.spotifyUri,
        trackName: resolved.trackName,
        primaryArtistId: resolved.primaryArtistId,
        primaryArtistName: resolved.primaryArtistName,
        albumId: resolved.albumId,
        albumName: resolved.albumName,
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
      if (
        evidence.spotifyTrackId === currentTrackId &&
        evidence.spotifyArtistId === resolved.primaryArtistId
      ) {
        continue;
      }
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

    await tx.artistAffinityEvidence.upsert({
      where: {
        userId_type_spotifyTrackId_spotifyArtistId: {
          userId: input.userId,
          type: ArtistAffinityEvidenceType.LIKED_TRACK,
          spotifyTrackId: currentTrackId,
          spotifyArtistId: resolved.primaryArtistId,
        },
      },
      create: {
        userId: input.userId,
        spotifyTrackId: currentTrackId,
        spotifyArtistId: resolved.primaryArtistId,
        artistName: resolved.primaryArtistName,
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
        firstProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        firstObservedAt: now,
        lastChangedAt: now,
        removedAt: null,
      },
      update: {
        artistName: resolved.primaryArtistName,
        active: true,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastChangedAt: now,
        removedAt: null,
      },
    });

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
        spotifyArtistId === resolved.primaryArtistId
          ? resolved.primaryArtistName
          : undefined;

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
          // Keep the product action attached to the historical candidate that
          // the user actually saw. The current provider ID is canonicalized in
          // LikedTrackPreference and affinity evidence instead.
          spotifyTrackId: historicalTrackId,
          source: HistoryLikeActionSource.PROBABLE_LIKE,
        },
      },
      create: {
        userId: input.userId,
        spotifyTrackId: historicalTrackId,
        source: HistoryLikeActionSource.PROBABLE_LIKE,
        trackName: snapshot.trackName,
        artistName: snapshot.artistName,
        primaryArtistId: resolved.primaryArtistId,
        candidateScore: snapshot.score,
        candidateReasons: snapshot.reasons,
        artistAffinityUpdated: true,
        providerWriteAttempted: true,
        firstConfirmedAt: now,
        lastConfirmedAt: now,
        confirmCount: 1,
      },
      update: {
        trackName: snapshot.trackName,
        artistName: snapshot.artistName,
        primaryArtistId: resolved.primaryArtistId,
        candidateScore: snapshot.score,
        candidateReasons: snapshot.reasons,
        artistAffinityUpdated: true,
        providerWriteAttempted: true,
        lastConfirmedAt: now,
        confirmCount: { increment: 1 },
      },
    });

    return true;
  });

  return {
    historicalSpotifyTrackId: historicalTrackId,
    spotifyTrackId: currentTrackId,
    trackName: resolved.trackName,
    artistName: resolved.primaryArtistName,
    identityResolution: resolved.resolution,
    alreadyLiked: Boolean(
      historicalPreference?.isLiked || currentPreference?.isLiked,
    ),
    artistAffinityUpdated,
    providerWriteAttempted: true,
    providerWriteSucceeded: true,
    providerWriteReason: "SAVED_TO_SPOTIFY_LIBRARY",
  };
}

async function canonicalizeAlreadyLikedRelink(input: {
  userId: string;
  historicalSpotifyTrackId: string;
  currentSpotifyTrackId: string;
  currentSpotifyArtistId: string | null;
  currentArtistName: string;
}): Promise<void> {
  if (input.historicalSpotifyTrackId === input.currentSpotifyTrackId) return;

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const oldEvidence = await tx.artistAffinityEvidence.findMany({
      where: {
        userId: input.userId,
        spotifyTrackId: input.historicalSpotifyTrackId,
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      select: { id: true, spotifyArtistId: true },
    });

    const affectedArtistIds = new Set(
      oldEvidence.map((evidence) => evidence.spotifyArtistId),
    );
    if (input.currentSpotifyArtistId) {
      affectedArtistIds.add(input.currentSpotifyArtistId);
    }
    const orderedAffectedArtistIds = [...affectedArtistIds].sort();

    for (const spotifyArtistId of orderedAffectedArtistIds) {
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

    await tx.likedTrackPreference.updateMany({
      where: {
        userId: input.userId,
        spotifyTrackId: input.historicalSpotifyTrackId,
        isLiked: true,
      },
      data: {
        isLiked: false,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastObservedAt: now,
        unlikedAt: now,
      },
    });

    await tx.artistAffinityEvidence.updateMany({
      where: {
        userId: input.userId,
        spotifyTrackId: input.historicalSpotifyTrackId,
        type: ArtistAffinityEvidenceType.LIKED_TRACK,
        active: true,
      },
      data: {
        active: false,
        lastProvenance: LikedTrackPreferenceProvenance.LIKED_TRACK_SYNC,
        lastChangedAt: now,
        removedAt: now,
      },
    });

    for (const spotifyArtistId of orderedAffectedArtistIds) {
      const likedTrackCount = await tx.artistAffinityEvidence.count({
        where: {
          userId: input.userId,
          spotifyArtistId,
          type: ArtistAffinityEvidenceType.LIKED_TRACK,
          active: true,
        },
      });

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
          artistName:
            spotifyArtistId === input.currentSpotifyArtistId
              ? input.currentArtistName
              : null,
          likedTrackCount,
          active: likedTrackCount > 0,
          firstObservedAt: now,
          lastChangedAt: now,
        },
        update: {
          ...(spotifyArtistId === input.currentSpotifyArtistId
            ? { artistName: input.currentArtistName }
            : {}),
          likedTrackCount,
          active: likedTrackCount > 0,
          lastChangedAt: now,
        },
      });
    }
  });
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export class ProbableLikeCandidateNotFoundError extends Error {
  constructor() {
    super("A faixa não faz mais parte do ranking de provável curtida.");
    this.name = "ProbableLikeCandidateNotFoundError";
  }
}
