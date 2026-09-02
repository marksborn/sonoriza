import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import type {
  SpotifyDisconnectInventory,
  SpotifyDisconnectInventoryStore,
} from "./spotify-disconnect-preview";

type InventoryRow = {
  oauthAccount: bigint;
  sourcePlaylistCache: bigint;
  sourcePlaylistBinding: bigint;
  targetPlaylistBinding: bigint;
  musicIngestionRuntimeState: bigint;
  musicIngestionBinding: bigint;
  trackListeningState: bigint;
  spotifyListeningEvent: bigint;
  mixedListeningEvent: bigint;
  spotifyExtendedHistoryImportRun: bigint;
  episodeListeningState: bigint;
  likedTrackPreference: bigint;
  artistAffinityEvidence: bigint;
  artistAffinityState: bigint;
  artistSimilaritySeed: bigint;
  artistSimilarityEdge: bigint;
  musicPreferenceSignal: bigint;
  albumRecommendationMemory: bigint;
  generationAuditWithProviderFields: bigint;
  firstPartyPlaybackPreference: bigint;
  nativeSourcePreference: bigint;
  userAccount: bigint;
};

export class PrismaSpotifyDisconnectInventoryStore
  implements SpotifyDisconnectInventoryStore
{
  constructor(private readonly client: PrismaClient = defaultPrisma) {}

  async load(userId: string): Promise<SpotifyDisconnectInventory> {
    if (!userId.trim()) throw new Error("Spotify disconnect inventory requires userId");

    const rows = await this.client.$queryRaw<InventoryRow[]>(Prisma.sql`
      SELECT
        (SELECT COUNT(*) FROM "Account"
          WHERE "userId" = ${userId} AND "provider" = 'spotify') AS "oauthAccount",
        (SELECT COUNT(*) FROM "SourcePlaylist"
          WHERE "userId" = ${userId}
            AND (
              "cachedCandidates" IS NOT NULL
              OR "spotifySnapshotId" IS NOT NULL
              OR "cacheUpdatedAt" IS NOT NULL
            )) AS "sourcePlaylistCache",
        (SELECT COUNT(*) FROM "SourcePlaylist"
          WHERE "userId" = ${userId}) AS "sourcePlaylistBinding",
        (SELECT COUNT(*) FROM "TargetPlaylist"
          WHERE "userId" = ${userId} AND "spotifyPlaylistId" IS NOT NULL) AS "targetPlaylistBinding",
        (SELECT COUNT(*) FROM "MusicIngestionRule"
          WHERE "userId" = ${userId}
            AND (
              "state" IS NOT NULL
              OR "lastSyncAt" IS NOT NULL
              OR "lastSuccessAt" IS NOT NULL
              OR "capabilityStatus" <> 'UNKNOWN'::"MusicIngestionCapabilityStatus"
              OR "capabilityMessage" IS NOT NULL
            )) AS "musicIngestionRuntimeState",
        (SELECT COUNT(*) FROM "MusicIngestionRule"
          WHERE "userId" = ${userId}) AS "musicIngestionBinding",
        (SELECT COUNT(*) FROM "TrackListeningState"
          WHERE "userId" = ${userId}) AS "trackListeningState",
        (SELECT COUNT(*) FROM "TrackListeningEvent"
          WHERE "userId" = ${userId}
            AND "source" IN (
              'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource",
              'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
            )) AS "spotifyListeningEvent",
        (SELECT COUNT(*) FROM "TrackListeningEvent"
          WHERE "userId" = ${userId}
            AND "source" NOT IN (
              'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource",
              'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
            )
            AND (COALESCE("metadata", '{}'::jsonb) ? 'spotifyExtendedHistory')) AS "mixedListeningEvent",
        (SELECT COUNT(*) FROM "SpotifyExtendedHistoryImportRun"
          WHERE "userId" = ${userId}) AS "spotifyExtendedHistoryImportRun",
        (SELECT COUNT(*) FROM "EpisodeListeningState"
          WHERE "userId" = ${userId}) AS "episodeListeningState",
        (SELECT COUNT(*) FROM "LikedTrackPreference"
          WHERE "userId" = ${userId}) AS "likedTrackPreference",
        (SELECT COUNT(*) FROM "ArtistAffinityEvidence"
          WHERE "userId" = ${userId}) AS "artistAffinityEvidence",
        (SELECT COUNT(*) FROM "ArtistAffinityState"
          WHERE "userId" = ${userId}) AS "artistAffinityState",
        (SELECT COUNT(*) FROM "ArtistSimilaritySeedState"
          WHERE "userId" = ${userId}) AS "artistSimilaritySeed",
        (SELECT COUNT(*) FROM "ArtistSimilarityEdge"
          WHERE "userId" = ${userId}) AS "artistSimilarityEdge",
        (SELECT COUNT(*) FROM "MusicPreferenceSignal"
          WHERE "userId" = ${userId}) AS "musicPreferenceSignal",
        (SELECT COUNT(*) FROM "AlbumRecommendationMemory"
          WHERE "userId" = ${userId}) AS "albumRecommendationMemory",
        (
          (SELECT COUNT(*) FROM "GenerationRun"
            WHERE "userId" = ${userId} AND "summary" IS NOT NULL)
          +
          (SELECT COUNT(*) FROM "GenerationItem" item
            INNER JOIN "GenerationRun" run ON run."id" = item."runId"
            WHERE run."userId" = ${userId})
          +
          (SELECT COUNT(*) FROM "GenerationLog" log
            INNER JOIN "GenerationRun" run ON run."id" = log."runId"
            WHERE run."userId" = ${userId} AND log."data" IS NOT NULL)
        ) AS "generationAuditWithProviderFields",
        (SELECT COUNT(*) FROM "FirstPartyPlaybackPreference"
          WHERE "userId" = ${userId}) AS "firstPartyPlaybackPreference",
        (SELECT COUNT(*) FROM "NativeSourcePreference"
          WHERE "userId" = ${userId}) AS "nativeSourcePreference",
        (SELECT COUNT(*) FROM "User"
          WHERE "id" = ${userId}) AS "userAccount"
    `);

    const row = rows[0];
    if (!row) throw new Error("Spotify disconnect inventory returned no row");

    return {
      oauthAccount: asCount(row.oauthAccount),
      sourcePlaylistCache: asCount(row.sourcePlaylistCache),
      sourcePlaylistBinding: asCount(row.sourcePlaylistBinding),
      targetPlaylistBinding: asCount(row.targetPlaylistBinding),
      musicIngestionRuntimeState: asCount(row.musicIngestionRuntimeState),
      musicIngestionBinding: asCount(row.musicIngestionBinding),
      trackListeningState: asCount(row.trackListeningState),
      spotifyListeningEvent: asCount(row.spotifyListeningEvent),
      mixedListeningEvent: asCount(row.mixedListeningEvent),
      spotifyExtendedHistoryImportRun: asCount(row.spotifyExtendedHistoryImportRun),
      episodeListeningState: asCount(row.episodeListeningState),
      likedTrackPreference: asCount(row.likedTrackPreference),
      artistAffinityEvidence: asCount(row.artistAffinityEvidence),
      artistAffinityState: asCount(row.artistAffinityState),
      artistSimilaritySeed: asCount(row.artistSimilaritySeed),
      artistSimilarityEdge: asCount(row.artistSimilarityEdge),
      musicPreferenceSignal: asCount(row.musicPreferenceSignal),
      albumRecommendationMemory: asCount(row.albumRecommendationMemory),
      generationAuditWithProviderFields: asCount(row.generationAuditWithProviderFields),
      firstPartyPlaybackPreference: asCount(row.firstPartyPlaybackPreference),
      nativeSourcePreference: asCount(row.nativeSourcePreference),
      userAccount: asCount(row.userAccount),
    };
  }
}

function asCount(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Spotify disconnect inventory count is not a safe integer: ${value}`);
  }
  return result;
}
