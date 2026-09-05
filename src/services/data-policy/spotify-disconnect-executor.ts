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
  SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
  SPOTIFY_DISCONNECT_REDACTED_URI,
} from "./spotify-disconnect-redaction";
import {
  SPOTIFY_DISCONNECT_CONTRACT_VERSION,
  type SpotifyDisconnectAction,
} from "./spotify-retention-contract";

export const SPOTIFY_DISCONNECT_ERROR_CODES = {
  USER_NOT_FOUND: "DATA_POLICY_SPOTIFY_DISCONNECT_USER_NOT_FOUND",
  CONTRACT_VERSION_MISMATCH:
    "DATA_POLICY_SPOTIFY_DISCONNECT_CONTRACT_VERSION_MISMATCH",
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
  contractVersion: typeof SPOTIFY_DISCONNECT_CONTRACT_VERSION;
  inventory: SpotifyDisconnectInventory;
  preview: SpotifyDisconnectPreview;
  fingerprint: string;
  confirmationPhrase: string;
}>;

export type SpotifyDisconnectExecutionInput = Readonly<{
  userId: string;
  contractVersion: number;
  expectedFingerprint: string;
  confirmation: string;
}>;

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

export type SpotifyDisconnectExecutionResult = Readonly<{
  userId: string;
  contractVersion: typeof SPOTIFY_DISCONNECT_CONTRACT_VERSION;
  fingerprint: string;
  beforeInventory: SpotifyDisconnectInventory;
  beforePreview: SpotifyDisconnectPreview;
  afterInventory: SpotifyDisconnectInventory;
  afterPreview: SpotifyDisconnectPreview;
  mutations: SpotifyDisconnectMutationCounts;
  preservationBefore: SpotifyDisconnectPreservationSnapshot;
  preservationAfter: SpotifyDisconnectPreservationSnapshot;
}>;

type LockScope = (
  tx: Prisma.TransactionClient,
  userId: string,
) => Promise<void>;

const DESTRUCTIVE_ACTIONS = new Set<SpotifyDisconnectAction>([
  "DELETE",
  "CLEAR_PROVIDER_PAYLOAD",
  "SANITIZE_SPOTIFY_LINEAGE",
  "REDACT_PROVIDER_FIELDS",
]);

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
    contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
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
  contractVersion: number;
  inventory: SpotifyDisconnectInventory;
  expectedFingerprint: string;
  confirmation: string;
}): string {
  if (input.contractVersion !== SPOTIFY_DISCONNECT_CONTRACT_VERSION) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.CONTRACT_VERSION_MISMATCH,
      `Spotify disconnect contract changed: expected v${SPOTIFY_DISCONNECT_CONTRACT_VERSION}, received v${input.contractVersion}. Generate a new preview.`,
    );
  }

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
 * Gate 6B v2 local provider disconnect executor.
 *
 * The caller must first display a preparation returned by
 * `prepareSpotifyDisconnect`. Execution re-locks and re-inventories inside a
 * SERIALIZABLE transaction; any changed inventory invalidates the fingerprint.
 *
 * No Spotify HTTP/API call is performed here. The local OAuth grant is deleted
 * last, after provider-derived state has been deleted/sanitized/redacted and
 * before the in-transaction postcheck commits.
 */
export async function executeSpotifyDisconnect(
  input: SpotifyDisconnectExecutionInput,
  dependencies: {
    client?: PrismaClient;
    lockScope?: LockScope;
  } = {},
): Promise<SpotifyDisconnectExecutionResult> {
  assertUserId(input.userId);

  const client = dependencies.client ?? defaultPrisma;
  const lockScope = dependencies.lockScope ?? lockSpotifyDisconnectScope;

  return client.$transaction(
    async (tx) => {
      await lockScope(tx, input.userId);

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
        contractVersion: input.contractVersion,
        inventory: beforeInventory,
        expectedFingerprint: input.expectedFingerprint,
        confirmation: input.confirmation,
      });

      const beforePreview = buildSpotifyDisconnectPreview(beforeInventory);
      const preservationBefore = await loadPreservationSnapshot(
        tx,
        input.userId,
      );

      const mutations = await applySpotifyDisconnectMutations(tx, input.userId);

      const afterInventory = await inventoryStore.load(input.userId);
      const afterPreview = buildSpotifyDisconnectPreview(afterInventory);
      const preservationAfter = await loadPreservationSnapshot(tx, input.userId);

      assertSpotifyDisconnectPostcheck({
        beforeInventory,
        afterInventory,
        afterPreview,
        preservationBefore,
        preservationAfter,
      });

      return {
        userId: input.userId,
        contractVersion: SPOTIFY_DISCONNECT_CONTRACT_VERSION,
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
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 120_000,
    },
  );
}

export function assertSpotifyDisconnectPostcheck(input: {
  beforeInventory: SpotifyDisconnectInventory;
  afterInventory: SpotifyDisconnectInventory;
  afterPreview?: SpotifyDisconnectPreview;
  preservationBefore: SpotifyDisconnectPreservationSnapshot;
  preservationAfter: SpotifyDisconnectPreservationSnapshot;
}): void {
  const afterPreview =
    input.afterPreview ?? buildSpotifyDisconnectPreview(input.afterInventory);

  const residue = afterPreview.items.filter(
    (item) => item.affectedRows > 0 && DESTRUCTIVE_ACTIONS.has(item.action),
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
        `Spotify disconnect changed preserved state ${key}: ${String(
          input.preservationBefore[key],
        )} -> ${String(input.preservationAfter[key])}`,
      );
    }
  }

  if (input.afterInventory.userAccount !== 1) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
      "Spotify disconnect removed or duplicated the Sonoriza user account.",
    );
  }

  if (input.afterInventory.oauthAccount !== 0) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
      "Spotify OAuth credentials remain after disconnect.",
    );
  }

  if (
    input.afterInventory.unrelatedOauthAccount !==
      input.beforeInventory.unrelatedOauthAccount ||
    input.afterInventory.googleCalendarSelection !==
      input.beforeInventory.googleCalendarSelection ||
    input.afterInventory.lastFmBackfillRun !==
      input.beforeInventory.lastFmBackfillRun ||
    input.afterInventory.firstPartyPlaybackPreference !==
      input.beforeInventory.firstPartyPlaybackPreference ||
    input.afterInventory.nativeSourcePreference !==
      input.beforeInventory.nativeSourcePreference
  ) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
      "Spotify disconnect changed independent-provider or first-party row counts.",
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
      AND (
        "error" IS NOT NULL
        OR "summary" IS NOT NULL
      )
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

  // Credentials are removed last. No provider-side HTTP revocation occurs in
  // this transaction; only the local Auth.js Spotify grant is deleted.
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

async function loadPreservationSnapshot(
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

async function lockSpotifyDisconnectScope(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  // Disconnect is rare and destructive. SHARE ROW EXCLUSIVE blocks concurrent
  // writes to the covered tables while ordinary readers remain available. This
  // makes the inventory -> mutation -> postcheck window deterministic even for
  // cron/provider writers that do not know about the disconnect operation.
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
  if (users.length !== 1) {
    throw new SpotifyDisconnectError(
      SPOTIFY_DISCONNECT_ERROR_CODES.USER_NOT_FOUND,
      `Spotify disconnect user does not exist: ${userId}`,
    );
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Account"
    WHERE "userId" = ${userId} AND "provider" = 'spotify'
    ORDER BY "id"
    FOR UPDATE
  `);
}

function assertUserId(userId: string): void {
  if (!userId.trim()) throw new Error("Spotify disconnect requires userId");
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
