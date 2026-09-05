import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import type {
  SpotifyDisconnectInventory,
  SpotifyDisconnectInventoryStore,
} from "./spotify-disconnect-preview";
import {
  SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX,
  SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
  SPOTIFY_DISCONNECT_REDACTED_URI,
} from "./spotify-disconnect-redaction";

type InventoryRow = {
  oauthAccount: bigint;
  unrelatedOauthAccount: bigint;
  userProfileProviderFields: bigint;
  googleCalendarSelection: bigint;
  sourcePlaylistCache: bigint;
  sourcePlaylistBinding: bigint;
  targetPlaylistBinding: bigint;
  musicPlaybackRuntimeState: bigint;
  musicPlaybackPolicy: bigint;
  podcastShowRuntimeState: bigint;
  podcastShowPolicy: bigint;
  musicIngestionRuntimeState: bigint;
  musicIngestionBinding: bigint;
  musicSourceCleanupAudit: bigint;
  musicIngestionAudit: bigint;
  targetScheduleAudit: bigint;
  notificationDeliveryAudit: bigint;
  trackListeningState: bigint;
  spotifyListeningEvent: bigint;
  mixedListeningEvent: bigint;
  pureLastFmListeningEvent: bigint;
  lastFmBackfillRun: bigint;
  spotifyExtendedHistoryImportRun: bigint;
  episodeListeningState: bigint;
  likedTrackPreference: bigint;
  artistAffinityEvidence: bigint;
  artistAffinityState: bigint;
  artistSimilaritySeed: bigint;
  artistSimilarityEdge: bigint;
  musicPreferenceSignal: bigint;
  albumRecommendationMemory: bigint;
  probableLikePilotFeedback: bigint;
  historyLikeAction: bigint;
  historyProbableLikeDismissal: bigint;
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
        (SELECT COUNT(*) FROM "Account"
          WHERE "userId" = ${userId} AND "provider" <> 'spotify') AS "unrelatedOauthAccount",
        (SELECT COUNT(*) FROM "User"
          WHERE "id" = ${userId} AND ("name" IS NOT NULL OR "image" IS NOT NULL)) AS "userProfileProviderFields",
        (SELECT COUNT(*) FROM "CalendarSelection"
          WHERE "userId" = ${userId}) AS "googleCalendarSelection",
        (SELECT COUNT(*) FROM "SourcePlaylist"
          WHERE "userId" = ${userId}
            AND (
              "name" IS NOT NULL
              OR "cachedCandidates" IS NOT NULL
              OR "spotifySnapshotId" IS NOT NULL
              OR "cacheUpdatedAt" IS NOT NULL
            )) AS "sourcePlaylistCache",
        (SELECT COUNT(*) FROM "SourcePlaylist"
          WHERE "userId" = ${userId}) AS "sourcePlaylistBinding",
        (SELECT COUNT(*) FROM "TargetPlaylist"
          WHERE "userId" = ${userId} AND "spotifyPlaylistId" IS NOT NULL) AS "targetPlaylistBinding",
        (SELECT COUNT(*) FROM "MusicPlaybackPolicy"
          WHERE "userId" = ${userId}
            AND (
              "historyKnownSince" IS NOT NULL
              OR "lastSyncAt" IS NOT NULL
              OR "syncAfterCursor" IS NOT NULL
            )) AS "musicPlaybackRuntimeState",
        (SELECT COUNT(*) FROM "MusicPlaybackPolicy"
          WHERE "userId" = ${userId}) AS "musicPlaybackPolicy",
        (SELECT COUNT(*) FROM "PodcastShowPolicy" policy
          INNER JOIN "SourcePlaylist" source ON source."id" = policy."sourcePlaylistId"
          WHERE source."userId" = ${userId}
            AND (
              policy."sequenceCursorEpisodeId" IS NOT NULL
              OR policy."sequenceCompleted" = true
              OR policy."randomRound" <> 0
              OR policy."randomConsumedEpisodeIds" <> '[]'::jsonb
            )) AS "podcastShowRuntimeState",
        (SELECT COUNT(*) FROM "PodcastShowPolicy" policy
          INNER JOIN "SourcePlaylist" source ON source."id" = policy."sourcePlaylistId"
          WHERE source."userId" = ${userId}) AS "podcastShowPolicy",
        (SELECT COUNT(*) FROM "MusicIngestionRule"
          WHERE "userId" = ${userId}
            AND (
              "sourceName" IS NOT NULL
              OR "state" IS NOT NULL
              OR "lastSyncAt" IS NOT NULL
              OR "lastSuccessAt" IS NOT NULL
              OR "capabilityStatus" <> 'UNKNOWN'::"MusicIngestionCapabilityStatus"
              OR "capabilityMessage" IS NOT NULL
            )) AS "musicIngestionRuntimeState",
        (SELECT COUNT(*) FROM "MusicIngestionRule"
          WHERE "userId" = ${userId}) AS "musicIngestionBinding",
        (SELECT COUNT(*) FROM "MusicSourceCleanupRun"
          WHERE "userId" = ${userId}
            AND (
              "snapshotBefore" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "snapshotAfter" IS NOT NULL
              OR "planHash" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "plannedUris" <> '[]'::jsonb
              OR "removedUris" IS NOT NULL
              OR "failedUris" IS NOT NULL
              OR "error" IS NOT NULL
            )) AS "musicSourceCleanupAudit",
        (SELECT COUNT(*) FROM "MusicIngestionRun"
          WHERE "userId" = ${userId}
            AND ("details" IS NOT NULL OR "error" IS NOT NULL)) AS "musicIngestionAudit",
        (
          (SELECT COUNT(*) FROM "TargetScheduleRun"
            WHERE "userId" = ${userId}
              AND (
                "snapshotBefore" IS NOT NULL
                OR "snapshotAfter" IS NOT NULL
                OR "reason" IS NOT NULL
                OR "details" IS NOT NULL
              ))
          +
          (SELECT COUNT(*) FROM "TargetScheduleAttempt" attempt
            INNER JOIN "TargetScheduleRun" run ON run."id" = attempt."targetScheduleRunId"
            WHERE run."userId" = ${userId}
              AND (attempt."reason" IS NOT NULL OR attempt."details" IS NOT NULL))
        ) AS "targetScheduleAudit",
        (SELECT COUNT(*) FROM "PushDelivery"
          WHERE "userId" = ${userId}
            AND (
              "payload" <> jsonb_build_object(
                'title', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
                'body', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
                'url', '/dashboard',
                'tag', ${SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG}
              )
              OR "lastError" IS NOT NULL
            )) AS "notificationDeliveryAudit",
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
            AND (
              COALESCE("metadata", '{}'::jsonb) ? 'spotifyExtendedHistory'
              OR "spotifyTrackId" IS NOT NULL
              OR "spotifyUri" IS NOT NULL
              OR "primaryArtistId" IS NOT NULL
              OR "albumId" IS NOT NULL
              OR COALESCE("contextUri", '') LIKE 'spotify:%'
            )) AS "mixedListeningEvent",
        (SELECT COUNT(*) FROM "TrackListeningEvent"
          WHERE "userId" = ${userId}
            AND "source" = 'LASTFM_SCROBBLE'::"ListeningEventSource"
            AND NOT (
              COALESCE("metadata", '{}'::jsonb) ? 'spotifyExtendedHistory'
              OR "spotifyTrackId" IS NOT NULL
              OR "spotifyUri" IS NOT NULL
              OR "primaryArtistId" IS NOT NULL
              OR "albumId" IS NOT NULL
              OR COALESCE("contextUri", '') LIKE 'spotify:%'
            )) AS "pureLastFmListeningEvent",
        (SELECT COUNT(*) FROM "LastFmBackfillRun"
          WHERE "userId" = ${userId}) AS "lastFmBackfillRun",
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
        (SELECT COUNT(*) FROM "ProbableLikePilotFeedback"
          WHERE "userId" = ${userId}
            AND (
              "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
              OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "candidateScore" <> 0
              OR "candidateReasons" <> '[]'::jsonb
            )) AS "probableLikePilotFeedback",
        (SELECT COUNT(*) FROM "HistoryLikeAction"
          WHERE "userId" = ${userId}
            AND (
              "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
              OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "primaryArtistId" IS NOT NULL
              OR "candidateScore" <> 0
              OR "candidateReasons" <> '[]'::jsonb
              OR "artistAffinityUpdated" = true
            )) AS "historyLikeAction",
        (SELECT COUNT(*) FROM "HistoryProbableLikeDismissal"
          WHERE "userId" = ${userId}
            AND (
              "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
              OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              OR "candidateScore" <> 0
              OR "candidateReasons" <> '[]'::jsonb
            )) AS "historyProbableLikeDismissal",
        (
          (SELECT COUNT(*) FROM "GenerationRun"
            WHERE "userId" = ${userId}
              AND ("summary" IS NOT NULL OR "error" IS NOT NULL))
          +
          (SELECT COUNT(*) FROM "GenerationItem" item
            INNER JOIN "GenerationRun" run ON run."id" = item."runId"
            WHERE run."userId" = ${userId}
              AND (
                item."spotifyUri" <> ${SPOTIFY_DISCONNECT_REDACTED_URI}
                OR item."title" IS NOT NULL
                OR item."subtitle" IS NOT NULL
                OR item."programId" IS NOT NULL
                OR item."durationMs" <> 0
                OR item."spotifyTrackId" IS NOT NULL
                OR item."primaryArtistId" IS NOT NULL
                OR item."albumId" IS NOT NULL
                OR item."originalDurationMs" IS NOT NULL
                OR item."resumePositionMs" IS NOT NULL
                OR item."sourceSpotifyType" IS NOT NULL
                OR item."sourceSpotifyId" IS NOT NULL
              ))
          +
          (SELECT COUNT(*) FROM "GenerationLog" log
            INNER JOIN "GenerationRun" run ON run."id" = log."runId"
            WHERE run."userId" = ${userId}
              AND (
                log."data" IS NOT NULL
                OR log."message" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
              ))
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
      unrelatedOauthAccount: asCount(row.unrelatedOauthAccount),
      userProfileProviderFields: asCount(row.userProfileProviderFields),
      googleCalendarSelection: asCount(row.googleCalendarSelection),
      sourcePlaylistCache: asCount(row.sourcePlaylistCache),
      sourcePlaylistBinding: asCount(row.sourcePlaylistBinding),
      targetPlaylistBinding: asCount(row.targetPlaylistBinding),
      musicPlaybackRuntimeState: asCount(row.musicPlaybackRuntimeState),
      musicPlaybackPolicy: asCount(row.musicPlaybackPolicy),
      podcastShowRuntimeState: asCount(row.podcastShowRuntimeState),
      podcastShowPolicy: asCount(row.podcastShowPolicy),
      musicIngestionRuntimeState: asCount(row.musicIngestionRuntimeState),
      musicIngestionBinding: asCount(row.musicIngestionBinding),
      musicSourceCleanupAudit: asCount(row.musicSourceCleanupAudit),
      musicIngestionAudit: asCount(row.musicIngestionAudit),
      targetScheduleAudit: asCount(row.targetScheduleAudit),
      notificationDeliveryAudit: asCount(row.notificationDeliveryAudit),
      trackListeningState: asCount(row.trackListeningState),
      spotifyListeningEvent: asCount(row.spotifyListeningEvent),
      mixedListeningEvent: asCount(row.mixedListeningEvent),
      pureLastFmListeningEvent: asCount(row.pureLastFmListeningEvent),
      lastFmBackfillRun: asCount(row.lastFmBackfillRun),
      spotifyExtendedHistoryImportRun: asCount(row.spotifyExtendedHistoryImportRun),
      episodeListeningState: asCount(row.episodeListeningState),
      likedTrackPreference: asCount(row.likedTrackPreference),
      artistAffinityEvidence: asCount(row.artistAffinityEvidence),
      artistAffinityState: asCount(row.artistAffinityState),
      artistSimilaritySeed: asCount(row.artistSimilaritySeed),
      artistSimilarityEdge: asCount(row.artistSimilarityEdge),
      musicPreferenceSignal: asCount(row.musicPreferenceSignal),
      albumRecommendationMemory: asCount(row.albumRecommendationMemory),
      probableLikePilotFeedback: asCount(row.probableLikePilotFeedback),
      historyLikeAction: asCount(row.historyLikeAction),
      historyProbableLikeDismissal: asCount(row.historyProbableLikeDismissal),
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
