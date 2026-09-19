import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { DataLineage } from "@/services/data-policy/provenance";
import { normalizeIsrcEvidence } from "./contracts";

const SPOTIFY_PROVIDER = "spotify";
const MATCH_REASON = "SINGLETON_BOOTSTRAP";
const CONFIDENCE_BASIS_POINTS = 10_000;

export type ShadowBackfillObservationSource =
  | "LIKED_TRACK_PREFERENCE"
  | "SPOTIFY_LISTENING_EVENT";

export type ShadowBackfillObservation = {
  source: ShadowBackfillObservationSource;
  observedAt: Date;
  spotifyTrackId: string | null;
  spotifyUri: string | null;
  trackName: string | null;
  primaryArtistId: string | null;
  primaryArtistName: string | null;
  albumId: string | null;
  albumName: string | null;
  isrc: string | null;
  trackMbid: string | null;
};

export type ShadowBackfillCandidate = {
  spotifyTrackId: string;
  spotifyUri: string | null;
  trackName: string;
  primaryArtistId: string;
  primaryArtistName: string;
  albumId: string | null;
  albumName: string | null;
  isrc: string | null;
  trackMbid: string | null;
  selectedSource: ShadowBackfillObservationSource;
  observedAt: Date;
};

export type ShadowBackfillCandidateBuild = {
  candidates: ShadowBackfillCandidate[];
  distinctSpotifyTracks: number;
  skippedIncompleteTracks: number;
  skippedConflictTracks: number;
};

export type ShadowBackfillSummary = {
  gate: "2B";
  mode: "DRY_RUN" | "WRITE";
  userId: string;
  sourceRows: {
    likedTrackPreferences: number;
    spotifyListeningEvents: number;
  };
  distinctSpotifyTracks: number;
  candidateTracks: number;
  skippedIncompleteTracks: number;
  skippedConflictTracks: number;
  alreadyPresentTrackRefs: number;
  created: {
    artistIdentities: number;
    artistProviderRefs: number;
    songIdentities: number;
    recordingIdentities: number;
    trackProviderRefs: number;
    albumIdentities: number;
    albumReleaseIdentities: number;
    albumReleaseProviderRefs: number;
  };
};

export function buildShadowBackfillCandidates(
  observations: ShadowBackfillObservation[],
): ShadowBackfillCandidateBuild {
  const byTrack = new Map<string, ShadowBackfillObservation[]>();

  for (const observation of observations) {
    const spotifyTrackId = clean(observation.spotifyTrackId);
    if (!spotifyTrackId) continue;
    const bucket = byTrack.get(spotifyTrackId) ?? [];
    bucket.push({ ...observation, spotifyTrackId });
    byTrack.set(spotifyTrackId, bucket);
  }

  const candidates: ShadowBackfillCandidate[] = [];
  let skippedIncompleteTracks = 0;
  let skippedConflictTracks = 0;

  for (const [spotifyTrackId, trackObservations] of byTrack) {
    const complete = trackObservations.filter(isCompleteObservation);
    if (complete.length === 0) {
      skippedIncompleteTracks += 1;
      continue;
    }

    if (hasStrongConflict(complete)) {
      skippedConflictTracks += 1;
      continue;
    }

    const selected = [...complete].sort(compareObservationPriority)[0]!;
    const albumId = singleNonEmptyValue(complete.map((row) => row.albumId));
    const albumName = albumId
      ? firstNonEmpty(
          complete
            .filter((row) => clean(row.albumId) === albumId)
            .sort(compareObservationPriority)
            .map((row) => row.albumName),
        )
      : null;

    const isrc = singleNormalizedIsrc(complete.map((row) => row.isrc));
    const trackMbid = singleNonEmptyValue(complete.map((row) => row.trackMbid));

    candidates.push({
      spotifyTrackId,
      spotifyUri: clean(selected.spotifyUri),
      trackName: clean(selected.trackName)!,
      primaryArtistId: clean(selected.primaryArtistId)!,
      primaryArtistName: clean(selected.primaryArtistName)!,
      albumId,
      albumName: albumId ? albumName : null,
      isrc,
      trackMbid,
      selectedSource: selected.source,
      observedAt: selected.observedAt,
    });
  }

  candidates.sort((a, b) => a.spotifyTrackId.localeCompare(b.spotifyTrackId));

  return {
    candidates,
    distinctSpotifyTracks: byTrack.size,
    skippedIncompleteTracks,
    skippedConflictTracks,
  };
}

export async function runMusicIdentityShadowBackfill(input: {
  userId: string;
  write?: boolean;
}): Promise<ShadowBackfillSummary> {
  const userId = clean(input.userId);
  if (!userId) throw new Error("userId is required");

  const userExists = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!userExists) throw new Error(`Sonoriza user not found: ${userId}`);

  const [likedRows, eventRows] = await Promise.all([
    prisma.likedTrackPreference.findMany({
      where: {
        userId,
        isLiked: true,
        availability: "AVAILABLE",
      },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        primaryArtistId: true,
        primaryArtistName: true,
        albumId: true,
        albumName: true,
        lastObservedAt: true,
      },
    }),
    prisma.trackListeningEvent.findMany({
      where: {
        userId,
        source: {
          in: ["SPOTIFY_RECENTLY_PLAYED", "SPOTIFY_EXTENDED_HISTORY"],
        },
        spotifyTrackId: { not: null },
      },
      orderBy: { playedAt: "desc" },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
        trackName: true,
        artistName: true,
        primaryArtistId: true,
        albumId: true,
        albumName: true,
        isrc: true,
        trackMbid: true,
        playedAt: true,
      },
    }),
  ]);

  const observations: ShadowBackfillObservation[] = [
    ...likedRows.map((row) => ({
      source: "LIKED_TRACK_PREFERENCE" as const,
      observedAt: row.lastObservedAt,
      spotifyTrackId: row.spotifyTrackId,
      spotifyUri: row.spotifyUri,
      trackName: row.trackName,
      primaryArtistId: row.primaryArtistId,
      primaryArtistName: row.primaryArtistName,
      albumId: row.albumId,
      albumName: row.albumName,
      isrc: null,
      trackMbid: null,
    })),
    ...eventRows.map((row) => ({
      source: "SPOTIFY_LISTENING_EVENT" as const,
      observedAt: row.playedAt,
      spotifyTrackId: row.spotifyTrackId,
      spotifyUri: row.spotifyUri,
      trackName: row.trackName,
      primaryArtistId: row.primaryArtistId,
      primaryArtistName: row.artistName,
      albumId: row.albumId,
      albumName: row.albumName,
      isrc: row.isrc,
      trackMbid: row.trackMbid,
    })),
  ];

  const built = buildShadowBackfillCandidates(observations);
  const baseSummary: ShadowBackfillSummary = {
    gate: "2B",
    mode: input.write ? "WRITE" : "DRY_RUN",
    userId,
    sourceRows: {
      likedTrackPreferences: likedRows.length,
      spotifyListeningEvents: eventRows.length,
    },
    distinctSpotifyTracks: built.distinctSpotifyTracks,
    candidateTracks: built.candidates.length,
    skippedIncompleteTracks: built.skippedIncompleteTracks,
    skippedConflictTracks: built.skippedConflictTracks,
    alreadyPresentTrackRefs: 0,
    created: emptyCreatedCounts(),
  };

  if (built.candidates.length === 0) return baseSummary;

  if (!input.write) {
    return dryRunSummary(baseSummary, built.candidates);
  }

  return writeCandidates(baseSummary, built.candidates);
}

async function dryRunSummary(
  summary: ShadowBackfillSummary,
  candidates: ShadowBackfillCandidate[],
): Promise<ShadowBackfillSummary> {
  const [existingTracks, existingArtists, existingAlbums] = await Promise.all([
    prisma.trackProviderRef.findMany({
      where: {
        userId: summary.userId,
        provider: SPOTIFY_PROVIDER,
        providerTrackId: { in: candidates.map((candidate) => candidate.spotifyTrackId) },
      },
      select: { providerTrackId: true },
    }),
    prisma.artistProviderRef.findMany({
      where: {
        userId: summary.userId,
        provider: SPOTIFY_PROVIDER,
        providerArtistId: {
          in: unique(candidates.map((candidate) => candidate.primaryArtistId)),
        },
      },
      select: { providerArtistId: true },
    }),
    prisma.albumReleaseProviderRef.findMany({
      where: {
        userId: summary.userId,
        provider: SPOTIFY_PROVIDER,
        providerAlbumId: {
          in: unique(
            candidates
              .map((candidate) => candidate.albumId)
              .filter((value): value is string => Boolean(value)),
          ),
        },
      },
      select: { providerAlbumId: true },
    }),
  ]);

  const existingTrackIds = new Set(existingTracks.map((row) => row.providerTrackId));
  const pending = candidates.filter(
    (candidate) => !existingTrackIds.has(candidate.spotifyTrackId),
  );
  const existingArtistIds = new Set(
    existingArtists.map((row) => row.providerArtistId),
  );
  const existingAlbumIds = new Set(
    existingAlbums.map((row) => row.providerAlbumId),
  );

  const newArtistIds = unique(
    pending
      .map((candidate) => candidate.primaryArtistId)
      .filter((id) => !existingArtistIds.has(id)),
  );
  const newAlbumIds = unique(
    pending
      .map((candidate) => candidate.albumId)
      .filter((id): id is string => id !== null && !existingAlbumIds.has(id)),
  );

  return {
    ...summary,
    alreadyPresentTrackRefs: candidates.length - pending.length,
    created: {
      artistIdentities: newArtistIds.length,
      artistProviderRefs: newArtistIds.length,
      songIdentities: pending.length,
      recordingIdentities: pending.length,
      trackProviderRefs: pending.length,
      albumIdentities: newAlbumIds.length,
      albumReleaseIdentities: newAlbumIds.length,
      albumReleaseProviderRefs: newAlbumIds.length,
    },
  };
}

async function writeCandidates(
  summary: ShadowBackfillSummary,
  candidates: ShadowBackfillCandidate[],
): Promise<ShadowBackfillSummary> {
  const created = emptyCreatedCounts();
  let alreadyPresentTrackRefs = 0;

  for (const candidate of candidates) {
    const existing = await prisma.trackProviderRef.findUnique({
      where: {
        userId_provider_providerTrackId: {
          userId: summary.userId,
          provider: SPOTIFY_PROVIDER,
          providerTrackId: candidate.spotifyTrackId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      alreadyPresentTrackRefs += 1;
      continue;
    }

    const delta = await prisma.$transaction(async (tx) => {
      const txCreated = emptyCreatedCounts();

      let artistRef = await tx.artistProviderRef.findUnique({
        where: {
          userId_provider_providerArtistId: {
            userId: summary.userId,
            provider: SPOTIFY_PROVIDER,
            providerArtistId: candidate.primaryArtistId,
          },
        },
        select: { artistIdentityId: true },
      });

      if (!artistRef) {
        const artist = await tx.artistIdentity.create({
          data: {
            userId: summary.userId,
            canonicalName: candidate.primaryArtistName,
          },
          select: { id: true },
        });
        txCreated.artistIdentities += 1;

        artistRef = await tx.artistProviderRef.create({
          data: {
            userId: summary.userId,
            artistIdentityId: artist.id,
            provider: SPOTIFY_PROVIDER,
            providerArtistId: candidate.primaryArtistId,
            matchReason: MATCH_REASON,
            confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
            resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
            observedAt: candidate.observedAt,
          },
          select: { artistIdentityId: true },
        });
        txCreated.artistProviderRefs += 1;
      }

      const song = await tx.songIdentity.create({
        data: {
          userId: summary.userId,
          primaryArtistIdentityId: artistRef.artistIdentityId,
          canonicalTitle: candidate.trackName,
        },
        select: { id: true },
      });
      txCreated.songIdentities += 1;

      const recording = await tx.recordingIdentity.create({
        data: {
          userId: summary.userId,
          songIdentityId: song.id,
        },
        select: { id: true },
      });
      txCreated.recordingIdentities += 1;

      await tx.trackProviderRef.create({
        data: {
          userId: summary.userId,
          recordingIdentityId: recording.id,
          provider: SPOTIFY_PROVIDER,
          providerTrackId: candidate.spotifyTrackId,
          uri: candidate.spotifyUri,
          isrc: candidate.isrc,
          trackMbid: candidate.trackMbid,
          executionStatus: "KNOWN",
          matchReason: MATCH_REASON,
          confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
          resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
          observedAt: candidate.observedAt,
        },
      });
      txCreated.trackProviderRefs += 1;

      if (candidate.albumId && candidate.albumName) {
        const existingAlbumRef = await tx.albumReleaseProviderRef.findUnique({
          where: {
            userId_provider_providerAlbumId: {
              userId: summary.userId,
              provider: SPOTIFY_PROVIDER,
              providerAlbumId: candidate.albumId,
            },
          },
          select: { id: true },
        });

        if (!existingAlbumRef) {
          const album = await tx.albumIdentity.create({
            data: {
              userId: summary.userId,
              canonicalTitle: candidate.albumName,
            },
            select: { id: true },
          });
          txCreated.albumIdentities += 1;

          const release = await tx.albumReleaseIdentity.create({
            data: {
              userId: summary.userId,
              albumIdentityId: album.id,
            },
            select: { id: true },
          });
          txCreated.albumReleaseIdentities += 1;

          await tx.albumReleaseProviderRef.create({
            data: {
              userId: summary.userId,
              albumReleaseIdentityId: release.id,
              provider: SPOTIFY_PROVIDER,
              providerAlbumId: candidate.albumId,
              matchReason: MATCH_REASON,
              confidenceBasisPoints: CONFIDENCE_BASIS_POINTS,
              resolutionLineage: spotifyLineage() as Prisma.InputJsonValue,
              observedAt: candidate.observedAt,
            },
          });
          txCreated.albumReleaseProviderRefs += 1;
        }
      }

      return txCreated;
    });

    addCreatedCounts(created, delta);
  }

  return {
    ...summary,
    alreadyPresentTrackRefs,
    created,
  };
}

function isCompleteObservation(
  observation: ShadowBackfillObservation,
): boolean {
  return Boolean(
    clean(observation.spotifyTrackId) &&
      clean(observation.trackName) &&
      clean(observation.primaryArtistId) &&
      clean(observation.primaryArtistName),
  );
}

function hasStrongConflict(observations: ShadowBackfillObservation[]): boolean {
  if (uniqueNonEmpty(observations.map((row) => row.primaryArtistId)).length > 1) {
    return true;
  }
  if (uniqueNonEmpty(observations.map((row) => row.albumId)).length > 1) {
    return true;
  }
  const normalizedIsrcs = unique(
    observations
      .map((row) => normalizeIsrcEvidence(row.isrc))
      .filter((value): value is string => Boolean(value)),
  );
  if (normalizedIsrcs.length > 1) return true;
  if (uniqueNonEmpty(observations.map((row) => row.trackMbid)).length > 1) {
    return true;
  }
  return false;
}

function compareObservationPriority(
  a: ShadowBackfillObservation,
  b: ShadowBackfillObservation,
): number {
  const sourcePriority = sourceRank(a.source) - sourceRank(b.source);
  if (sourcePriority !== 0) return sourcePriority;
  return b.observedAt.getTime() - a.observedAt.getTime();
}

function sourceRank(source: ShadowBackfillObservationSource): number {
  return source === "LIKED_TRACK_PREFERENCE" ? 0 : 1;
}

function singleNonEmptyValue(values: Array<string | null>): string | null {
  const normalized = uniqueNonEmpty(values);
  return normalized.length === 1 ? normalized[0]! : null;
}

function singleNormalizedIsrc(values: Array<string | null>): string | null {
  const normalized = unique(
    values
      .map((value) => normalizeIsrcEvidence(value))
      .filter((value): value is string => Boolean(value)),
  );
  return normalized.length === 1 ? normalized[0]! : null;
}

function firstNonEmpty(values: Array<string | null>): string | null {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function uniqueNonEmpty(values: Array<string | null>): string[] {
  return unique(
    values.map((value) => clean(value)).filter((value): value is string => Boolean(value)),
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function spotifyLineage(): DataLineage {
  return { origins: ["SPOTIFY"] };
}

function emptyCreatedCounts(): ShadowBackfillSummary["created"] {
  return {
    artistIdentities: 0,
    artistProviderRefs: 0,
    songIdentities: 0,
    recordingIdentities: 0,
    trackProviderRefs: 0,
    albumIdentities: 0,
    albumReleaseIdentities: 0,
    albumReleaseProviderRefs: 0,
  };
}

function addCreatedCounts(
  target: ShadowBackfillSummary["created"],
  delta: ShadowBackfillSummary["created"],
): void {
  for (const key of Object.keys(target) as Array<keyof ShadowBackfillSummary["created"]>) {
    target[key] += delta[key];
  }
}
