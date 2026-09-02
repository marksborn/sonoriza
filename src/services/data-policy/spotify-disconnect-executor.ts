import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import {
  buildSpotifyDisconnectPreview,
  type SpotifyDisconnectInventory,
  type SpotifyDisconnectPreview,
} from "./spotify-disconnect-preview";
import { PrismaSpotifyDisconnectInventoryStore } from "./spotify-disconnect-prisma-inventory";
import {
  SPOTIFY_DISCONNECT_REDACTED_ID_PREFIX,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
  SPOTIFY_DISCONNECT_REDACTED_URI,
} from "./spotify-disconnect-redaction";
import { SPOTIFY_DISCONNECT_CONTRACT_VERSION } from "./spotify-retention-contract";

export const SPOTIFY_DISCONNECT_ERROR_CODES = {
  USER_NOT_FOUND: "DATA_POLICY_SPOTIFY_DISCONNECT_USER_NOT_FOUND",
  PREVIEW_CHANGED: "DATA_POLICY_SPOTIFY_DISCONNECT_PREVIEW_CHANGED",
  CONFIRMATION_REQUIRED: "DATA_POLICY_SPOTIFY_DISCONNECT_CONFIRMATION_REQUIRED",
  POSTCHECK_FAILED: "DATA_POLICY_SPOTIFY_DISCONNECT_POSTCHECK_FAILED",
} as const;

export type SpotifyDisconnectErrorCode =
  (typeof SPOTIFY_DISCONNECT_ERROR_CODES)[keyof typeof SPOTIFY_DISCONNECT_ERROR_CODES];

export class SpotifyDisconnectError extends Error {
  readonly name = "SpotifyDisconnectError";

  constructor(
    readonly code: SpotifyDisconnectErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type SpotifyDisconnectPreparation = Readonly<{
  userId: string;
  inventory: SpotifyDisconnectInventory;
  preview: SpotifyDisconnectPreview;
  fingerprint: string;
  confirmationPhrase: string;
}>;

export type SpotifyDisconnectExecutionInput = Readonly<{
  userId: string;
  expectedFingerprint: string;
  confirmation: string;
}>;

export type SpotifyDisconnectPreservationSnapshot = Readonly<{
  sourcePlaylists: number;
  targetPlaylists: number;
  musicPlaybackPolicies: number;
  podcastShowPolicies: number;
  musicIngestionRules: number;
  musicSourceCleanupRuns: number;
  musicIngestionRuns: number;
  targetScheduleRuns: number;
  targetScheduleAttempts: number;
  generationRuns: number;
  generationItems: number;
  generationLogs: number;
  probableLikePilotFeedback: number;
  historyLikeActions: number;
  historyProbableLikeDismissals: number;
  firstPartyPlaybackPreferences: number;
  nativeSourcePreferences: number;
  users: number;
}>;

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

export type SpotifyDisconnectExecutionResult = Readonly<{
  userId: string;
  fingerprint: string;
  beforeInventory: SpotifyDisconnectInventory;
  beforePreview: SpotifyDisconnectPreview;
  afterInventory: SpotifyDisconnectInventory;
  afterPreview: SpotifyDisconnectPreview;
  mutations: SpotifyDisconnectMutationCounts;
  preservationBefore: SpotifyDisconnectPreservationSnapshot;
  preservationAfter: SpotifyDisconnectPreservationSnapshot;
}>;

type LockTables = (tx: Prisma.TransactionClient) => Promise<void>;

export async function prepareSpotifyDisconnect(
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<SpotifyDisconnectPreparation> {
  assertUserId(userId);
  const inventory = await new PrismaSpotifyDisconnectInventoryStore(client).load(
    userId,
  );
  if (inventory.userAccount !== 1) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.USER_NOT_FOUND,
      `Spotify disconnect user does not exist: ${userId}`,
    );
  }
  const preview = buildSpotifyDisconnectPreview(inventory);
  const fingerprint = spotifyDisconnectFingerprint(userId, inventory);
  return {
    userId,
    inventory,
    preview,
    fingerprint,
    confirmationPhrase: spotifyDisconnectConfirmationPhrase(fingerprint),
  };
}

export function spotifyDisconnectFingerprint(
  userId: string,
  inventory: SpotifyDisconnectInventory,
): string {
  assertUserId(userId);
  const sortedInventory = Object.fromEntries(
    Object.entries(inventory).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
        userId,
        inventory: sortedInventory,
      }),
    )
    .digest("hex");
}

export function spotifyDisconnectConfirmationPhrase(fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/i.test(fingerprint)) {
    throw new Error("Spotify disconnect fingerprint must be a SHA-256 hex string");
  }
  return `DISCONNECT SPOTIFY ${fingerprint.slice(0, 12).toUpperCase()}`;
}

export function assertSpotifyDisconnectAuthorization(input: {
  userId: string;
  inventory: SpotifyDisconnectInventory;
  expectedFingerprint: string;
  confirmation: string;
}): string {
  const actualFingerprint = spotifyDisconnectFingerprint(
    input.userId,
    input.inventory,
  );
  if (actualFingerprint !== input.expectedFingerprint) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED,
      "Spotify disconnect preview changed; generate a new preview before executing.",
    );
  }

  const expectedConfirmation =
    spotifyDisconnectConfirmationPhrase(actualFingerprint);
  if (input.confirmation !== expectedConfirmation) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.CONFIRMATION_REQUIRED,
      `Spotify disconnect requires exact confirmation: ${expectedConfirmation}`,
    );
  }
  return actualFingerprint;
}

/**
 * Gate 6B local disconnect executor.
 *
 * There is deliberately no UI/API route in this gate. Callers must first use
 * `prepareSpotifyDisconnect`, present that exact preview, and then supply both
 * its fingerprint and exact confirmation phrase. The executor re-inventories
 * inside the transaction and fails closed if the snapshot changed.
 *
 * This executor removes the locally stored OAuth grant and provider data. It
 * does not call a provider-side revocation endpoint.
 */
export async function executeSpotifyDisconnect(
  input: SpotifyDisconnectExecutionInput,
  dependencies: {
    client?: PrismaClient;
    lockTables?: LockTables;
  } = {},
): Promise<SpotifyDisconnectExecutionResult> {
  assertUserId(input.userId);
  const client = dependencies.client ?? defaultPrisma;
  const lockTables = dependencies.lockTables ?? lockSpotifyDisconnectTables;

  return client.$transaction(
    async (tx) => {
      await lockTables(tx);

      const inventoryStore = new PrismaSpotifyDisconnectInventoryStore(
        tx as unknown as PrismaClient,
      );
      const beforeInventory = await inventoryStore.load(input.userId);
      if (beforeInventory.userAccount !== 1) {
        throw new SpotifyDisconnectError(
          SPOTIFY_DISCONNECT_ERROR_CODES.USER_NOT_FOUND,
          `Spotify disconnect user does not exist: ${input.userId}`,
        );
      }

      const fingerprint = assertSpotifyDisconnectAuthorization({
        userId: input.userId,
        inventory: beforeInventory,
        expectedFingerprint: input.expectedFingerprint,
        confirmation: input.confirmation,
      });
      const beforePreview = buildSpotifyDisconnectPreview(beforeInventory);
      const preservationBefore = await loadPreservationSnapshot(tx, input.userId);

      const mutations = await applySpotifyDisconnectMutations(tx, input.userId);

      const afterInventory = await inventoryStore.load(input.userId);
      const afterPreview = buildSpotifyDisconnectPreview(afterInventory);
      const preservationAfter = await loadPreservationSnapshot(tx, input.userId);

      assertSpotifyDisconnectPostcheck({
        beforeInventory,
        afterInventory,
        preservationBefore,
        preservationAfter,
      });

      return {
        userId: input.userId,
        fingerprint,
        beforeInventory,
        beforePreview,
        afterInventory,
        afterPreview,
        mutations,
        preservationBefore,
        preservationAfter,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function assertSpotifyDisconnectPostcheck(input: {
  beforeInventory: SpotifyDisconnectInventory;
  afterInventory: SpotifyDisconnectInventory;
  preservationBefore: SpotifyDisconnectPreservationSnapshot;
  preservationAfter: SpotifyDisconnectPreservationSnapshot;
}): void {
  const afterPreview = buildSpotifyDisconnectPreview(input.afterInventory);
  const residue = afterPreview.items.filter(
    (item) => item.action !== "RETAIN_FIRST_PARTY" && item.affectedRows !== 0,
  );
  if (residue.length > 0) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
      `Spotify disconnect left provider residue: ${residue
        .map((item) => `${item.dataset}=${item.affectedRows}`)
        .join(", ")}`,
    );
  }

  for (const key of Object.keys(
    input.preservationBefore,
  ) as (keyof SpotifyDisconnectPreservationSnapshot)[]) {
    if (input.preservationBefore[key] !== input.preservationAfter[key]) {
      throw new SpotifyDisconnectError(
        SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
        `Spotify disconnect changed preserved row count ${key}: ${input.preservationBefore[key]} -> ${input.preservationAfter[key]}`,
      );
    }
  }

  if (input.afterInventory.userAccount !== 1) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
      "Spotify disconnect removed or duplicated the Sonoriza user account.",
    );
  }
}

async function applySpotifyDisconnectMutations(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SpotifyDisconnectMutationCounts> {
  const userProfileProviderFieldsCleared = await tx.$executeRaw(Prisma.sql`
    UPDATE "User"
    SET "name" = NULL, "image" = NULL
    WHERE "id" = ${userId} AND ("name" IS NOT NULL OR "image" IS NOT NULL)
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
      "albumName" = CASE
        WHEN COALESCE("metadata", '{}'::jsonb) ? 'spotifyExtendedHistory'
          THEN NULL
        ELSE "albumName"
      END,
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
  `);

  const generationRunsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "GenerationRun"
    SET "summary" = NULL, "error" = NULL
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
  `);

  const generationLogsRedacted = await tx.$executeRaw(Prisma.sql`
    UPDATE "GenerationLog" AS log
    SET
      "message" = ${SPOTIFY_DISCONNECT_REDACTED_TEXT},
      "data" = NULL
    FROM "GenerationRun" AS run
    WHERE run."id" = log."runId"
      AND run."userId" = ${userId}
  `);

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

async function loadPreservationSnapshot(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<SpotifyDisconnectPreservationSnapshot> {
  type Row = { [K in keyof SpotifyDisconnectPreservationSnapshot]: bigint };
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    SELECT
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
      (SELECT COUNT(*) FROM "User" WHERE "id" = ${userId}) AS "users"
  `);
  const row = rows[0];
  if (!row) throw new Error("Spotify disconnect preservation snapshot returned no row");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, asCount(value)]),
  ) as SpotifyDisconnectPreservationSnapshot;
}

async function lockSpotifyDisconnectTables(
  tx: Prisma.TransactionClient,
): Promise<void> {
  // The disconnect is intentionally rare and destructive. A short global write
  // lock prevents cron/provider writers from racing the snapshot, purge and
  // postcheck. Readers remain allowed under SHARE ROW EXCLUSIVE.
  await tx.$executeRawUnsafe(`
    LOCK TABLE
      "Account",
      "SourcePlaylist",
      "TargetPlaylist",
      "MusicPlaybackPolicy",
      "PodcastShowPolicy",
      "MusicIngestionRule",
      "MusicSourceCleanupRun",
      "MusicIngestionRun",
      "TargetScheduleRun",
      "TargetScheduleAttempt",
      "TrackListeningState",
      "TrackListeningEvent",
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
}

function assertUserId(userId: string): void {
  if (!userId.trim()) throw new Error("Spotify disconnect requires userId");
}

function asCount(value: unknown): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Spotify disconnect count is not a safe integer: ${String(value)}`);
  }
  return result;
}
