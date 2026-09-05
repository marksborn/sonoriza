import { Prisma } from "@prisma/client";

import {
  SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX,
  SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
  SPOTIFY_DISCONNECT_REDACTED_URI,
} from "./spotify-disconnect-redaction";

export type SpotifyDisconnectMutationCounts = Readonly<{
  userProfileProviderFieldsCleared: number;
  sourcePayloadsCleared: number;
  musicPlaybackRuntimeCleared: number;
  podcastRuntimeCleared: number;
  musicIngestionRuntimeCleared: number;
  musicSourceCleanupAuditsRedacted: number;
  musicIngestionAuditsRedacted: number;
  targetScheduleRunsRedacted: number;
  targetScheduleAttemptsRedacted: number;
  notificationDeliveryAuditsRedacted: number;
  spotifyListeningEventsDeleted: number;
  mixedListeningEventsSanitized: number;
  trackListeningStatesDeleted: number;
  spotifyExtendedHistoryRunsDeleted: number;
  episodeListeningStatesDeleted: number;
  artistSimilarityEdgesDeleted: number;
  artistSimilaritySeedsDeleted: number;
  artistAffinityEvidenceDeleted: number;
  likedTrackPreferencesDeleted: number;
  artistAffinityStatesDeleted: number;
  musicPreferenceSignalsDeleted: number;
  albumRecommendationMemoriesDeleted: number;
  probableLikePilotFeedbackRedacted: number;
  historyLikeActionsRedacted: number;
  historyProbableLikeDismissalsRedacted: number;
  generationRunsRedacted: number;
  generationItemsRedacted: number;
  generationLogsRedacted: number;
  oauthAccountsDeleted: number;
}>;

/**
 * Applies only the local database portion of a Spotify disconnect.
 *
 * No provider HTTP call exists in this module. The Spotify Auth.js account is
 * deleted last so any thrown error before the postcheck rolls the whole
 * transaction back with the credential still present.
 */
export async function applySpotifyDisconnectMutations(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SpotifyDisconnectMutationCounts> {
  const userProfileProviderFieldsCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "User"
    SET "name" = NULL, "image" = NULL
    WHERE "id" = ${userId}
      AND ("name" IS NOT NULL OR "image" IS NOT NULL)
  `);

  const sourcePayloadsCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "SourcePlaylist"
    SET
      "name" = NULL,
      "spotifySnapshotId" = NULL,
      "cachedCandidates" = NULL,
      "cacheUpdatedAt" = NULL
    WHERE "userId" = ${userId}
      AND (
        "name" IS NOT NULL
        OR "spotifySnapshotId" IS NOT NULL
        OR "cachedCandidates" IS NOT NULL
        OR "cacheUpdatedAt" IS NOT NULL
      )
  `);

  const musicPlaybackRuntimeCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "MusicPlaybackPolicy"
    SET
      "historyKnownSince" = NULL,
      "lastSyncAt" = NULL,
      "syncAfterCursor" = NULL
    WHERE "userId" = ${userId}
      AND (
        "historyKnownSince" IS NOT NULL
        OR "lastSyncAt" IS NOT NULL
        OR "syncAfterCursor" IS NOT NULL
      )
  `);

  const podcastRuntimeCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "PodcastShowPolicy" AS policy
    SET
      "sequenceCursorEpisodeId" = NULL,
      "sequenceCompleted" = false,
      "randomRound" = 0,
      "randomConsumedEpisodeIds" = '[]'::jsonb
    FROM "SourcePlaylist" AS source
    WHERE source."id" = policy."sourcePlaylistId"
      AND source."userId" = ${userId}
      AND (
        policy."sequenceCursorEpisodeId" IS NOT NULL
        OR policy."sequenceCompleted" = true
        OR policy."randomRound" <> 0
        OR policy."randomConsumedEpisodeIds" <> '[]'::jsonb
      )
  `);

  const musicIngestionRuntimeCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "MusicIngestionRule"
    SET
      "sourceName" = NULL,
      "state" = NULL,
      "capabilityStatus" = 'UNKNOWN'::"MusicIngestionCapabilityStatus",
      "capabilityMessage" = NULL,
      "lastSyncAt" = NULL,
      "lastSuccessAt" = NULL
    WHERE "userId" = ${userId}
      AND (
        "sourceName" IS NOT NULL
        OR "state" IS NOT NULL
        OR "capabilityStatus" <> 'UNKNOWN'::"MusicIngestionCapabilityStatus"
        OR "capabilityMessage" IS NOT NULL
        OR "lastSyncAt" IS NOT NULL
        OR "lastSuccessAt" IS NOT NULL
      )
  `);

  const musicSourceCleanupAuditsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "MusicSourceCleanupRun"
    SET
      "snapshotBefore" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "snapshotAfter" = NULL,
      "planHash" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "plannedUris" = '[]'::jsonb,
      "removedUris" = NULL,
      "failedUris" = NULL,
      "error" = NULL
    WHERE "userId" = ${userId}
      AND (
        "snapshotBefore" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "snapshotAfter" IS NOT NULL
        OR "planHash" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "plannedUris" <> '[]'::jsonb
        OR "removedUris" IS NOT NULL
        OR "failedUris" IS NOT NULL
        OR "error" IS NOT NULL
      )
  `);

  const musicIngestionAuditsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "MusicIngestionRun"
    SET "details" = NULL, "error" = NULL
    WHERE "userId" = ${userId}
      AND ("details" IS NOT NULL OR "error" IS NOT NULL)
  `);

  const targetScheduleRunsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "TargetScheduleRun"
    SET
      "snapshotBefore" = NULL,
      "snapshotAfter" = NULL,
      "reason" = NULL,
      "details" = NULL
    WHERE "userId" = ${userId}
      AND (
        "snapshotBefore" IS NOT NULL
        OR "snapshotAfter" IS NOT NULL
        OR "reason" IS NOT NULL
        OR "details" IS NOT NULL
      )
  `);

  const targetScheduleAttemptsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "TargetScheduleAttempt" AS attempt
    SET "reason" = NULL, "details" = NULL
    FROM "TargetScheduleRun" AS run
    WHERE run."id" = attempt."targetScheduleRunId"
      AND run."userId" = ${userId}
      AND (attempt."reason" IS NOT NULL OR attempt."details" IS NOT NULL)
  `);

  const notificationDeliveryAuditsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "PushDelivery"
    SET
      "payload" = jsonb_build_object(
        'title', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
        'body', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
        'url', '/dashboard',
        'tag', ${SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG}
      ),
      "lastError" = NULL
    WHERE "userId" = ${userId}
      AND (
        "payload" <> jsonb_build_object(
          'title', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
          'body', ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
          'url', '/dashboard',
          'tag', ${SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG}
        )
        OR "lastError" IS NOT NULL
      )
  `);

  const spotifyListeningEventsDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "TrackListeningEvent"
    WHERE "userId" = ${userId}
      AND "source" IN (
        'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource",
        'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
      )
  `);

  const mixedListeningEventsSanitized = await tx.$executeRaw(Prisma.sql`
    UPDATE "TrackListeningEvent"
    SET
      "spotifyTrackId" = NULL,
      "spotifyUri" = NULL,
      "primaryArtistId" = NULL,
      "albumId" = NULL,
      "albumName" = NULL,
      "contextType" = CASE
        WHEN COALESCE("contextUri", '') LIKE 'spotify:%' THEN NULL
        ELSE "contextType"
      END,
      "contextUri" = CASE
        WHEN COALESCE("contextUri", '') LIKE 'spotify:%' THEN NULL
        ELSE "contextUri"
      END,
      "metadata" = CASE
        WHEN COALESCE("metadata", '{}'::jsonb) ? 'spotifyExtendedHistory'
          THEN NULLIF("metadata" - 'spotifyExtendedHistory', '{}'::jsonb)
        ELSE "metadata"
      END
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
      )
  `);

  const trackListeningStatesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "TrackListeningState" WHERE "userId" = ${userId}
  `);

  const spotifyExtendedHistoryRunsDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "SpotifyExtendedHistoryImportRun" WHERE "userId" = ${userId}
  `);

  const episodeListeningStatesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "EpisodeListeningState" WHERE "userId" = ${userId}
  `);

  // Delete similarity children before their seed rows.
  const artistSimilarityEdgesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "ArtistSimilarityEdge" WHERE "userId" = ${userId}
  `);

  const artistSimilaritySeedsDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "ArtistSimilaritySeedState" WHERE "userId" = ${userId}
  `);

  const artistAffinityEvidenceDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "ArtistAffinityEvidence" WHERE "userId" = ${userId}
  `);

  const likedTrackPreferencesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "LikedTrackPreference" WHERE "userId" = ${userId}
  `);

  const artistAffinityStatesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "ArtistAffinityState" WHERE "userId" = ${userId}
  `);

  const musicPreferenceSignalsDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "MusicPreferenceSignal" WHERE "userId" = ${userId}
  `);

  const albumRecommendationMemoriesDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "AlbumRecommendationMemory" WHERE "userId" = ${userId}
  `);

  const probableLikePilotFeedbackRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "ProbableLikePilotFeedback"
    SET
      "spotifyTrackId" = ${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX} || "id",
      "trackName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "artistName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "candidateScore" = 0,
      "candidateReasons" = '[]'::jsonb
    WHERE "userId" = ${userId}
      AND (
        "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
        OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "candidateScore" <> 0
        OR "candidateReasons" <> '[]'::jsonb
      )
  `);

  const historyLikeActionsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "HistoryLikeAction"
    SET
      "spotifyTrackId" = ${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX} || "id",
      "trackName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "artistName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "primaryArtistId" = NULL,
      "candidateScore" = 0,
      "candidateReasons" = '[]'::jsonb,
      "artistAffinityUpdated" = false
    WHERE "userId" = ${userId}
      AND (
        "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
        OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "primaryArtistId" IS NOT NULL
        OR "candidateScore" <> 0
        OR "candidateReasons" <> '[]'::jsonb
        OR "artistAffinityUpdated" = true
      )
  `);

  const historyProbableLikeDismissalsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "HistoryProbableLikeDismissal"
    SET
      "spotifyTrackId" = ${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX} || "id",
      "trackName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "artistName" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "candidateScore" = 0,
      "candidateReasons" = '[]'::jsonb
    WHERE "userId" = ${userId}
      AND (
        "spotifyTrackId" NOT LIKE ${`${SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX}%`}
        OR "trackName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "artistName" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
        OR "candidateScore" <> 0
        OR "candidateReasons" <> '[]'::jsonb
      )
  `);

  // Preserve only the independently sourced MUSIC-06 explainability subtree.
  // Any other summary component is untyped/legacy and is removed conservatively.
  const generationRunsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "GenerationRun"
    SET
      "summary" = CASE
        WHEN "summary" IS NOT NULL
          AND jsonb_typeof("summary") = 'object'
          AND "summary" ? 'music06PlannerInfluence'
          THEN jsonb_build_object(
            'music06PlannerInfluence',
            "summary" -> 'music06PlannerInfluence'
          )
        ELSE NULL
      END,
      "error" = NULL
    WHERE "userId" = ${userId}
      AND ("summary" IS NOT NULL OR "error" IS NOT NULL)
  `);

  const generationItemsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "GenerationItem" AS item
    SET
      "spotifyUri" = ${SPOTIFY_DISCONNECT_REDACTED_URI},
      "title" = NULL,
      "subtitle" = NULL,
      "programId" = NULL,
      "durationMs" = 0,
      "spotifyTrackId" = NULL,
      "primaryArtistId" = NULL,
      "albumId" = NULL,
      "originalDurationMs" = NULL,
      "resumePositionMs" = NULL,
      "sourceSpotifyType" = NULL,
      "sourceSpotifyId" = NULL
    FROM "GenerationRun" AS run
    WHERE run."id" = item."runId"
      AND run."userId" = ${userId}
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
      )
  `);

  const generationLogsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "GenerationLog" AS log
    SET
      "message" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "data" = NULL
    FROM "GenerationRun" AS run
    WHERE run."id" = log."runId"
      AND run."userId" = ${userId}
      AND (
        log."data" IS NOT NULL
        OR log."message" <> ${SPOTIFY_DISCONNECT_REDACTED_TEXT}
      )
  `);

  // Local OAuth credentials are intentionally removed last.
  const oauthAccountsDeleted = await tx.$executeRaw(Prisma.sql`
    DELETE FROM "Account"
    WHERE "userId" = ${userId} AND "provider" = 'spotify'
  `);

  return {
    userProfileProviderFieldsCleared,
    sourcePayloadsCleared,
    musicPlaybackRuntimeCleared,
    podcastRuntimeCleared,
    musicIngestionRuntimeCleared,
    musicSourceCleanupAuditsRedacted,
    musicIngestionAuditsRedacted,
    targetScheduleRunsRedacted,
    targetScheduleAttemptsRedacted,
    notificationDeliveryAuditsRedacted,
    spotifyListeningEventsDeleted,
    mixedListeningEventsSanitized,
    trackListeningStatesDeleted,
    spotifyExtendedHistoryRunsDeleted,
    episodeListeningStatesDeleted,
    artistSimilarityEdgesDeleted,
    artistSimilaritySeedsDeleted,
    artistAffinityEvidenceDeleted,
    likedTrackPreferencesDeleted,
    artistAffinityStatesDeleted,
    musicPreferenceSignalsDeleted,
    albumRecommendationMemoriesDeleted,
    probableLikePilotFeedbackRedacted,
    historyLikeActionsRedacted,
    historyProbableLikeDismissalsRedacted,
    generationRunsRedacted,
    generationItemsRedacted,
    generationLogsRedacted,
    oauthAccountsDeleted,
  };
}
