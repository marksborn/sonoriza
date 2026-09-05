import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import { loadSpotifyDisconnectExecutionInventory } from "./spotify-disconnect-effective-inventory";
import {
  applySpotifyDisconnectMutations,
  type SpotifyDisconnectMutationCounts,
} from "./spotify-disconnect-mutations";
import {
  buildSpotifyDisconnectPreview,
  type SpotifyDisconnectInventory,
  type SpotifyDisconnectPreview,
} from "./spotify-disconnect-preview";
import {
  loadSpotifyDisconnectPreservationSnapshot,
  lockSpotifyDisconnectScope,
  type SpotifyDisconnectPreservationSnapshot,
} from "./spotify-disconnect-preservation";
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
) => Promise<boolean>;

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

  const inventory = await loadSpotifyDisconnectExecutionInventory(client, userId);
  if (inventory.userAccount !== 1) {
    throw userNotFound(userId);
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
 * Executes only the local database portion of a Spotify disconnect.
 *
 * Safety properties:
 * - SERIALIZABLE transaction;
 * - write locks across all participating tables + User/Spotify Account rows;
 * - fresh in-transaction inventory compared with the user's preview fingerprint;
 * - exact confirmation phrase derived from that fingerprint;
 * - Spotify credential deletion last;
 * - independent-provider / first-party preservation fingerprint postcheck;
 * - no Spotify HTTP/API request.
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
      const lockedUserExists = await lockScope(tx, input.userId);
      if (!lockedUserExists) throw userNotFound(input.userId);

      const beforeInventory = await loadSpotifyDisconnectExecutionInventory(
        tx as unknown as PrismaClient,
        input.userId,
      );
      if (beforeInventory.userAccount !== 1) throw userNotFound(input.userId);

      const fingerprint = assertSpotifyDisconnectAuthorization({
        userId: input.userId,
        contractVersion: input.contractVersion,
        inventory: beforeInventory,
        expectedFingerprint: input.expectedFingerprint,
        confirmation: input.confirmation,
      });

      const beforePreview = buildSpotifyDisconnectPreview(beforeInventory);
      const preservationBefore = await loadSpotifyDisconnectPreservationSnapshot(
        tx,
        input.userId,
      );

      const mutations = await applySpotifyDisconnectMutations(tx, input.userId);

      const afterInventory = await loadSpotifyDisconnectExecutionInventory(
        tx as unknown as PrismaClient,
        input.userId,
      );
      const afterPreview = buildSpotifyDisconnectPreview(afterInventory);
      const preservationAfter = await loadSpotifyDisconnectPreservationSnapshot(
        tx,
        input.userId,
      );

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

  for (const key of [
    "unrelatedOauthAccount",
    "googleCalendarSelection",
    "lastFmBackfillRun",
    "firstPartyPlaybackPreference",
    "nativeSourcePreference",
  ] as const) {
    if (input.afterInventory[key] !== input.beforeInventory[key]) {
      throw new SpotifyDisconnectError(
        SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED,
        `Spotify disconnect changed retained inventory ${key}: ${input.beforeInventory[key]} -> ${input.afterInventory[key]}`,
      );
    }
  }
}

function userNotFound(userId: string): SpotifyDisconnectError {
  return new SpotifyDisconnectError(
    SPOTIFY_DISCONNECT_ERROR_CODES.USER_NOT_FOUND,
    `Spotify disconnect user does not exist: ${userId}`,
  );
}

function assertUserId(userId: string): void {
  if (!userId.trim()) throw new Error("Spotify disconnect requires userId");
}
