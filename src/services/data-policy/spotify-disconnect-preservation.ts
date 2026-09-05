import { Prisma } from "@prisma/client";

export type SpotifyDisconnectPreservationSnapshot = Readonly<{
  unrelatedOauthAccounts: number;
  googleCalendarSelections: number;
  independentListeningEvents: number;
  lastFmBackfillRuns: number;
  sourcePlaylists: number;
  targetPlaylists: number;
  musicPlaybackPolicies: number;
  podcastShowPolicies: number;
  musicIngestionRules: number;
  musicSourceCleanupRuns: number;
  musicIngestionRuns: number;
  targetScheduleRuns: number;
  targetScheduleAttempts: number;
  pushDeliveries: number;
  generationRuns: number;
  generationItems: number;
  generationLogs: number;
  probableLikePilotFeedback: number;
  historyLikeActions: number;
  historyProbableLikeDismissals: number;
  firstPartyPlaybackPreferences: number;
  nativeSourcePreferences: number;
  users: number;
  unrelatedOauthFingerprint: string;
  googleCalendarFingerprint: string;
  independentListeningFingerprint: string;
  lastFmBackfillFingerprint: string;
  firstPartyPlaybackPreferenceFingerprint: string;
  nativeSourcePreferenceFingerprint: string;
  userIdentityFingerprint: string;
}>;

export async function loadSpotifyDisconnectPreservationSnapshot(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SpotifyDisconnectPreservationSnapshot> {
  type Row = {
    unrelatedOauthAccounts: bigint;
    googleCalendarSelections: bigint;
    independentListeningEvents: bigint;
    lastFmBackfillRuns: bigint;
    sourcePlaylists: bigint;
    targetPlaylists: bigint;
    musicPlaybackPolicies: bigint;
    podcastShowPolicies: bigint;
    musicIngestionRules: bigint;
    musicSourceCleanupRuns: bigint;
    musicIngestionRuns: bigint;
    targetScheduleRuns: bigint;
    targetScheduleAttempts: bigint;
    pushDeliveries: bigint;
    generationRuns: bigint;
    generationItems: bigint;
    generationLogs: bigint;
    probableLikePilotFeedback: bigint;
    historyLikeActions: bigint;
    historyProbableLikeDismissals: bigint;
    firstPartyPlaybackPreferences: bigint;
    nativeSourcePreferences: bigint;
    users: bigint;
    unrelatedOauthFingerprint: string;
    googleCalendarFingerprint: string;
    independentListeningFingerprint: string;
    lastFmBackfillFingerprint: string;
    firstPartyPlaybackPreferenceFingerprint: string;
    nativeSourcePreferenceFingerprint: string;
    userIdentityFingerprint: string;
  };

  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT
      (SELECT COUNT(*) FROM "Account"
        WHERE "userId" = ${userId} AND "provider" <> 'spotify') AS "unrelatedOauthAccounts",
      (SELECT COUNT(*) FROM "CalendarSelection"
        WHERE "userId" = ${userId}) AS "googleCalendarSelections",
      (SELECT COUNT(*) FROM "TrackListeningEvent"
        WHERE "userId" = ${userId}
          AND "source" NOT IN (
            'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource",
            'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
          )) AS "independentListeningEvents",
      (SELECT COUNT(*) FROM "LastFmBackfillRun"
        WHERE "userId" = ${userId}) AS "lastFmBackfillRuns",
      (SELECT COUNT(*) FROM "SourcePlaylist" WHERE "userId" = ${userId}) AS "sourcePlaylists",
      (SELECT COUNT(*) FROM "TargetPlaylist" WHERE "userId" = ${userId}) AS "targetPlaylists",
      (SELECT COUNT(*) FROM "MusicPlaybackPolicy" WHERE "userId" = ${userId}) AS "musicPlaybackPolicies",
      (SELECT COUNT(*) FROM "PodcastShowPolicy" policy
        INNER JOIN "SourcePlaylist" source ON source."id" = policy."sourcePlaylistId"
        WHERE source."userId" = ${userId}) AS "podcastShowPolicies",
      (SELECT COUNT(*) FROM "MusicIngestionRule" WHERE "userId" = ${userId}) AS "musicIngestionRules",
      (SELECT COUNT(*) FROM "MusicSourceCleanupRun" WHERE "userId" = ${userId}) AS "musicSourceCleanupRuns",
      (SELECT COUNT(*) FROM "MusicIngestionRun" WHERE "userId" = ${userId}) AS "musicIngestionRuns",
      (SELECT COUNT(*) FROM "TargetScheduleRun" WHERE "userId" = ${userId}) AS "targetScheduleRuns",
      (SELECT COUNT(*) FROM "TargetScheduleAttempt" attempt
        INNER JOIN "TargetScheduleRun" run ON run."id" = attempt."targetScheduleRunId"
        WHERE run."userId" = ${userId}) AS "targetScheduleAttempts",
      (SELECT COUNT(*) FROM "PushDelivery" WHERE "userId" = ${userId}) AS "pushDeliveries",
      (SELECT COUNT(*) FROM "GenerationRun" WHERE "userId" = ${userId}) AS "generationRuns",
      (SELECT COUNT(*) FROM "GenerationItem" item
        INNER JOIN "GenerationRun" run ON run."id" = item."runId"
        WHERE run."userId" = ${userId}) AS "generationItems",
      (SELECT COUNT(*) FROM "GenerationLog" log
        INNER JOIN "GenerationRun" run ON run."id" = log."runId"
        WHERE run."userId" = ${userId}) AS "generationLogs",
      (SELECT COUNT(*) FROM "ProbableLikePilotFeedback" WHERE "userId" = ${userId}) AS "probableLikePilotFeedback",
      (SELECT COUNT(*) FROM "HistoryLikeAction" WHERE "userId" = ${userId}) AS "historyLikeActions",
      (SELECT COUNT(*) FROM "HistoryProbableLikeDismissal" WHERE "userId" = ${userId}) AS "historyProbableLikeDismissals",
      (SELECT COUNT(*) FROM "FirstPartyPlaybackPreference" WHERE "userId" = ${userId}) AS "firstPartyPlaybackPreferences",
      (SELECT COUNT(*) FROM "NativeSourcePreference" WHERE "userId" = ${userId}) AS "nativeSourcePreferences",
      (SELECT COUNT(*) FROM "User" WHERE "id" = ${userId}) AS "users",

      md5(COALESCE((
        SELECT string_agg(to_jsonb(account_row)::text, E'\n' ORDER BY account_row."id")
        FROM "Account" account_row
        WHERE account_row."userId" = ${userId}
          AND account_row."provider" <> 'spotify'
      ), '')) AS "unrelatedOauthFingerprint",

      md5(COALESCE((
        SELECT string_agg(to_jsonb(calendar_row)::text, E'\n' ORDER BY calendar_row."id")
        FROM "CalendarSelection" calendar_row
        WHERE calendar_row."userId" = ${userId}
      ), '')) AS "googleCalendarFingerprint",

      md5(COALESCE((
        SELECT string_agg(
          jsonb_build_object(
            'id', event_row."id",
            'source', event_row."source",
            'sourceEventKey', event_row."sourceEventKey",
            'trackName', event_row."trackName",
            'artistName', event_row."artistName",
            'playedAt', event_row."playedAt",
            'isrc', event_row."isrc",
            'trackMbid', event_row."trackMbid",
            'artistMbid', event_row."artistMbid",
            'albumMbid', event_row."albumMbid"
          )::text,
          E'\n' ORDER BY event_row."id"
        )
        FROM "TrackListeningEvent" event_row
        WHERE event_row."userId" = ${userId}
          AND event_row."source" NOT IN (
            'SPOTIFY_RECENTLY_PLAYED'::"ListeningEventSource",
            'SPOTIFY_EXTENDED_HISTORY'::"ListeningEventSource"
          )
      ), '')) AS "independentListeningFingerprint",

      md5(COALESCE((
        SELECT string_agg(to_jsonb(backfill_row)::text, E'\n' ORDER BY backfill_row."id")
        FROM "LastFmBackfillRun" backfill_row
        WHERE backfill_row."userId" = ${userId}
      ), '')) AS "lastFmBackfillFingerprint",

      md5(COALESCE((
        SELECT string_agg(to_jsonb(preference_row)::text, E'\n' ORDER BY preference_row."id")
        FROM "FirstPartyPlaybackPreference" preference_row
        WHERE preference_row."userId" = ${userId}
      ), '')) AS "firstPartyPlaybackPreferenceFingerprint",

      md5(COALESCE((
        SELECT string_agg(to_jsonb(native_row)::text, E'\n' ORDER BY native_row."id")
        FROM "NativeSourcePreference" native_row
        WHERE native_row."userId" = ${userId}
      ), '')) AS "nativeSourcePreferenceFingerprint",

      md5(COALESCE((
        SELECT jsonb_build_object(
          'id', user_row."id",
          'email', user_row."email",
          'emailVerified', user_row."emailVerified",
          'createdAt', user_row."createdAt"
        )::text
        FROM "User" user_row
        WHERE user_row."id" = ${userId}
      ), '')) AS "userIdentityFingerprint"
  `);

  const row = rows[0];
  if (!row) {
    throw new Error("Spotify disconnect preservation snapshot returned no row");
  }

  return {
    unrelatedOauthAccounts: asCount(row.unrelatedOauthAccounts),
    googleCalendarSelections: asCount(row.googleCalendarSelections),
    independentListeningEvents: asCount(row.independentListeningEvents),
    lastFmBackfillRuns: asCount(row.lastFmBackfillRuns),
    sourcePlaylists: asCount(row.sourcePlaylists),
    targetPlaylists: asCount(row.targetPlaylists),
    musicPlaybackPolicies: asCount(row.musicPlaybackPolicies),
    podcastShowPolicies: asCount(row.podcastShowPolicies),
    musicIngestionRules: asCount(row.musicIngestionRules),
    musicSourceCleanupRuns: asCount(row.musicSourceCleanupRuns),
    musicIngestionRuns: asCount(row.musicIngestionRuns),
    targetScheduleRuns: asCount(row.targetScheduleRuns),
    targetScheduleAttempts: asCount(row.targetScheduleAttempts),
    pushDeliveries: asCount(row.pushDeliveries),
    generationRuns: asCount(row.generationRuns),
    generationItems: asCount(row.generationItems),
    generationLogs: asCount(row.generationLogs),
    probableLikePilotFeedback: asCount(row.probableLikePilotFeedback),
    historyLikeActions: asCount(row.historyLikeActions),
    historyProbableLikeDismissals: asCount(row.historyProbableLikeDismissals),
    firstPartyPlaybackPreferences: asCount(row.firstPartyPlaybackPreferences),
    nativeSourcePreferences: asCount(row.nativeSourcePreferences),
    users: asCount(row.users),
    unrelatedOauthFingerprint: row.unrelatedOauthFingerprint,
    googleCalendarFingerprint: row.googleCalendarFingerprint,
    independentListeningFingerprint: row.independentListeningFingerprint,
    lastFmBackfillFingerprint: row.lastFmBackfillFingerprint,
    firstPartyPlaybackPreferenceFingerprint:
      row.firstPartyPlaybackPreferenceFingerprint,
    nativeSourcePreferenceFingerprint: row.nativeSourcePreferenceFingerprint,
    userIdentityFingerprint: row.userIdentityFingerprint,
  };
}

/**
 * Locks every table that participates in the destructive snapshot. Disconnect
 * is intentionally rare; a short global SHARE ROW EXCLUSIVE lock prevents cron
 * and provider writers from changing the snapshot while normal readers remain
 * available. User and Spotify Account rows are then locked explicitly too.
 */
export async function lockSpotifyDisconnectScope(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  await tx.$executeRawUnsafe(`
    LOCK TABLE
      "Account",
      "CalendarSelection",
      "SourcePlaylist",
      "TargetPlaylist",
      "MusicPlaybackPolicy",
      "PodcastShowPolicy",
      "MusicIngestionRule",
      "MusicSourceCleanupRun",
      "MusicIngestionRun",
      "TargetScheduleRun",
      "TargetScheduleAttempt",
      "PushDelivery",
      "TrackListeningState",
      "TrackListeningEvent",
      "LastFmBackfillRun",
      "SpotifyExtendedHistoryImportRun",
      "EpisodeListeningState",
      "LikedTrackPreference",
      "ArtistAffinityEvidence",
      "ArtistAffinityState",
      "ArtistSimilaritySeedState",
      "ArtistSimilarityEdge",
      "MusicPreferenceSignal",
      "AlbumRecommendationMemory",
      "ProbableLikePilotFeedback",
      "HistoryLikeAction",
      "HistoryProbableLikeDismissal",
      "GenerationRun",
      "GenerationItem",
      "GenerationLog",
      "FirstPartyPlaybackPreference",
      "NativeSourcePreference",
      "User"
    IN SHARE ROW EXCLUSIVE MODE
  `);

  const users = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `);

  if (users.length !== 1) return false;

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Account"
    WHERE "userId" = ${userId} AND "provider" = 'spotify'
    ORDER BY "id"
    FOR UPDATE
  `);

  return true;
}

function asCount(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(
      `Spotify disconnect count is not a safe integer: ${String(value)}`,
    );
  }
  return result;
}
