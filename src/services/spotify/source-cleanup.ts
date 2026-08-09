import { createHash } from "node:crypto";

import {
  MusicSourceCleanupStatus,
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
  type Prisma,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { spotifyApiErrorFromResponse } from "./errors";
import {
  spotifyTrackIdentityAliases,
  syncRecentlyPlayed,
} from "./recently-played";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;
const MAX_DELETE_ITEMS = 100;

export class MusicSourceCleanupError extends Error {}
export class MusicSourceCleanupHistoryRequiredError extends MusicSourceCleanupError {}
export class MusicSourceCleanupPermissionError extends MusicSourceCleanupError {}
export class MusicSourceCleanupStaleError extends MusicSourceCleanupError {}

export type PlaylistCleanupOccurrence = {
  uri: string | null;
  aliases: string[];
  isTrack: boolean;
  isLocal: boolean;
};

export type MusicSourceCleanupPlan = {
  examinedCount: number;
  removableTrackCount: number;
  removalOccurrenceCount: number;
  keptCount: number;
  removableUris: string[];
  planHash: string;
};

export type MusicSourceCleanupPreviewResult = MusicSourceCleanupPlan & {
  previewId: string;
  sourcePlaylistId: string;
  sourceName: string;
  spotifyPlaylistId: string;
  snapshotId: string;
  historyKnownSince: Date | null;
  historyLastSyncAt: Date | null;
};

export type MusicSourceCleanupExecutionResult = {
  runId: string;
  status: MusicSourceCleanupStatus;
  examinedCount: number;
  plannedTrackCount: number;
  plannedOccurrenceCount: number;
  removedTrackCount: number;
  failedTrackCount: number;
  snapshotAfter: string | null;
};

type PlaylistMetadata = {
  name?: string | null;
  snapshot_id?: string | null;
  collaborative?: boolean | null;
  owner?: { id?: string | null } | null;
};

type PlaylistItemsPage = {
  items?: Array<{
    is_local?: boolean | null;
    item?: {
      id?: string | null;
      uri?: string | null;
      type?: string | null;
      linked_from?: { id?: string | null } | null;
    } | null;
  }>;
  next?: string | null;
  total?: number | null;
};

type StablePlaylistRead = {
  name: string;
  snapshotId: string;
  occurrences: PlaylistCleanupOccurrence[];
};

export function buildMusicSourceCleanupPlan(
  occurrences: PlaylistCleanupOccurrence[],
  playedTrackIds: ReadonlySet<string>,
): MusicSourceCleanupPlan {
  const removableUris = new Set<string>();
  let removalOccurrenceCount = 0;

  for (const occurrence of occurrences) {
    if (
      !occurrence.isTrack ||
      occurrence.isLocal ||
      !occurrence.uri ||
      occurrence.aliases.length === 0
    ) {
      continue;
    }

    const wasPlayed = occurrence.aliases.some((alias) => playedTrackIds.has(alias));
    if (!wasPlayed) continue;

    removalOccurrenceCount += 1;
    removableUris.add(occurrence.uri);
  }

  const sortedUris = [...removableUris].sort();
  const planHash = hashCleanupPlan(sortedUris, removalOccurrenceCount);

  return {
    examinedCount: occurrences.length,
    removableTrackCount: sortedUris.length,
    removalOccurrenceCount,
    keptCount: Math.max(0, occurrences.length - removalOccurrenceCount),
    removableUris: sortedUris,
    planHash,
  };
}

export function hashCleanupPlan(
  removableUris: string[],
  removalOccurrenceCount: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        removableUris: [...removableUris].sort(),
        removalOccurrenceCount,
      }),
    )
    .digest("hex");
}

/**
 * Creates and persists a dry-run only. Spotify is read, never mutated.
 * The preview includes the exact playlist snapshot and plan hash that a later
 * explicit confirmation must reproduce before any DELETE is sent.
 */
export async function createMusicSourceCleanupPreview(
  userId: string,
  sourcePlaylistId: string,
  now = new Date(),
): Promise<MusicSourceCleanupPreviewResult> {
  const source = await loadManagedMusicSource(userId, sourcePlaylistId);
  if (source.musicRetentionMode !== MusicSourceRetentionMode.REMOVE_AFTER_PLAYED) {
    throw new MusicSourceCleanupError(
      "Esta fonte está configurada para manter todos os itens. Ative o modo inbox antes do preview.",
    );
  }

  const history = await syncRecentlyPlayed(userId, now);
  if (!history.enabled) {
    throw new MusicSourceCleanupHistoryRequiredError(
      "O histórico nativo precisa estar ativo antes da limpeza da fonte.",
    );
  }

  const [playlist, playedStates] = await Promise.all([
    readStablePlaylist(userId, source.spotifyId),
    prisma.trackListeningState.findMany({
      where: { userId },
      select: { spotifyTrackId: true },
    }),
  ]);

  const plan = buildMusicSourceCleanupPlan(
    playlist.occurrences,
    new Set(playedStates.map((state) => state.spotifyTrackId)),
  );

  const run = await prisma.musicSourceCleanupRun.create({
    data: {
      userId,
      sourcePlaylistId: source.id,
      status: MusicSourceCleanupStatus.PREVIEW,
      snapshotBefore: playlist.snapshotId,
      planHash: plan.planHash,
      examinedCount: plan.examinedCount,
      removableTrackCount: plan.removableTrackCount,
      removalOccurrenceCount: plan.removalOccurrenceCount,
      keptCount: plan.keptCount,
      plannedUris: plan.removableUris as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  return {
    ...plan,
    previewId: run.id,
    sourcePlaylistId: source.id,
    sourceName: source.name ?? playlist.name,
    spotifyPlaylistId: source.spotifyId,
    snapshotId: playlist.snapshotId,
    historyKnownSince: history.historyKnownSince,
    historyLastSyncAt: history.lastSyncAt,
  };
}

/**
 * Executes one previously persisted preview. It synchronizes playback history
 * again, rereads the entire source and compares both snapshot and plan hash.
 * Any drift makes the preview stale and zero DELETE requests are sent.
 */
export async function executeMusicSourceCleanupPreview(
  userId: string,
  previewId: string,
  now = new Date(),
): Promise<MusicSourceCleanupExecutionResult> {
  const preview = await prisma.musicSourceCleanupRun.findFirst({
    where: { id: previewId, userId },
    include: { source: true },
  });

  if (!preview || preview.status !== MusicSourceCleanupStatus.PREVIEW) {
    throw new MusicSourceCleanupError("Preview de limpeza inválido ou já consumido.");
  }
  if (
    preview.source.kind !== SourceKind.MUSIC ||
    preview.source.spotifyType !== SpotifySourceType.PLAYLIST ||
    preview.source.musicRetentionMode !== MusicSourceRetentionMode.REMOVE_AFTER_PLAYED
  ) {
    throw new MusicSourceCleanupError("A fonte não está mais habilitada como inbox de música.");
  }

  const plannedUris = parseStringArray(preview.plannedUris);
  const uniquePlannedUris = new Set(plannedUris);
  if (
    plannedUris.length !== uniquePlannedUris.size ||
    preview.removableTrackCount !== plannedUris.length ||
    preview.removalOccurrenceCount < preview.removableTrackCount
  ) {
    throw new MusicSourceCleanupError(
      "O preview de limpeza está inconsistente. Gere um novo preview antes de confirmar.",
    );
  }
  if (
    !preview.source.musicCleanupFirstCompletedAt &&
    (preview.removableTrackCount < 1 ||
      preview.removalOccurrenceCount < 1 ||
      plannedUris.length < 1)
  ) {
    throw new MusicSourceCleanupError(
      "Preview sem faixas removíveis não pode concluir a primeira limpeza.",
    );
  }

  const history = await syncRecentlyPlayed(userId, now);
  if (!history.enabled) {
    throw new MusicSourceCleanupHistoryRequiredError(
      "O histórico nativo precisa permanecer ativo para executar a limpeza.",
    );
  }

  const current = await readStablePlaylist(userId, preview.source.spotifyId);
  const playedStates = await prisma.trackListeningState.findMany({
    where: { userId },
    select: { spotifyTrackId: true },
  });
  const currentPlan = buildMusicSourceCleanupPlan(
    current.occurrences,
    new Set(playedStates.map((state) => state.spotifyTrackId)),
  );

  if (
    current.snapshotId !== preview.snapshotBefore ||
    currentPlan.planHash !== preview.planHash
  ) {
    await prisma.musicSourceCleanupRun.update({
      where: { id: preview.id },
      data: {
        status: MusicSourceCleanupStatus.STALE,
        finishedAt: now,
        error:
          "A playlist ou o histórico mudou depois do preview; nenhuma remoção foi executada.",
      },
    });
    throw new MusicSourceCleanupStaleError(
      "O preview ficou desatualizado. Gere um novo preview antes de confirmar a limpeza.",
    );
  }

  let snapshotAfter: string | null = current.snapshotId;

  try {
    if (plannedUris.length > 0) {
      const accessToken = await getSpotifyAccessToken(userId);
      for (const uris of chunk(plannedUris, MAX_DELETE_ITEMS)) {
        const result: { snapshot_id?: string | null } = await spotifyRequest(
          accessToken,
          `/playlists/${preview.source.spotifyId}/items`,
          {
            method: "DELETE",
            body: JSON.stringify({
              items: uris.map((uri) => ({ uri })),
              snapshot_id: snapshotAfter,
            }),
          },
        );
        snapshotAfter = result.snapshot_id ?? snapshotAfter;
      }
    }

    const verification = await readStablePlaylist(userId, preview.source.spotifyId);
    snapshotAfter = verification.snapshotId;
    const remainingUris = new Set(
      verification.occurrences
        .map((occurrence) => occurrence.uri)
        .filter((uri): uri is string => Boolean(uri) && plannedUris.includes(uri!)),
    );
    const failedUris = plannedUris.filter((uri) => remainingUris.has(uri));
    const removedUris = plannedUris.filter((uri) => !remainingUris.has(uri));
    const status =
      failedUris.length === 0
        ? MusicSourceCleanupStatus.SUCCESS
        : MusicSourceCleanupStatus.PARTIAL;

    await prisma.$transaction([
      prisma.musicSourceCleanupRun.update({
        where: { id: preview.id },
        data: {
          status,
          snapshotAfter,
          removedUris: removedUris as Prisma.InputJsonValue,
          failedUris: failedUris as Prisma.InputJsonValue,
          finishedAt: new Date(),
          error:
            failedUris.length > 0
              ? `${failedUris.length} item(ns) planejado(s) permaneceram na playlist após a tentativa.`
              : null,
        },
      }),
      prisma.sourcePlaylist.update({
        where: { id: preview.source.id },
        data: {
          musicCleanupLastRunAt: new Date(),
          ...(status === MusicSourceCleanupStatus.SUCCESS &&
          !preview.source.musicCleanupFirstCompletedAt
            ? { musicCleanupFirstCompletedAt: new Date() }
            : {}),
          // The source changed on Spotify. Force the normal reader to validate
          // and rebuild its cache on the next generation.
          spotifySnapshotId: null,
          cacheUpdatedAt: null,
        },
      }),
    ]);

    return {
      runId: preview.id,
      status,
      examinedCount: preview.examinedCount,
      plannedTrackCount: plannedUris.length,
      plannedOccurrenceCount: preview.removalOccurrenceCount,
      removedTrackCount: removedUris.length,
      failedTrackCount: failedUris.length,
      snapshotAfter,
    };
  } catch (error) {
    const diagnosis = await diagnoseAfterFailedDelete(
      userId,
      preview.source.spotifyId,
      plannedUris,
    );
    const status =
      diagnosis.removedUris.length > 0
        ? MusicSourceCleanupStatus.PARTIAL
        : MusicSourceCleanupStatus.FAILED;
    const message = error instanceof Error ? error.message : String(error);

    await prisma.$transaction([
      prisma.musicSourceCleanupRun.update({
        where: { id: preview.id },
        data: {
          status,
          snapshotAfter: diagnosis.snapshotId,
          removedUris: diagnosis.removedUris as Prisma.InputJsonValue,
          failedUris: diagnosis.failedUris as Prisma.InputJsonValue,
          finishedAt: new Date(),
          error: message,
        },
      }),
      prisma.sourcePlaylist.update({
        where: { id: preview.source.id },
        data: {
          musicCleanupLastRunAt: new Date(),
          spotifySnapshotId: null,
          cacheUpdatedAt: null,
        },
      }),
    ]);

    throw error;
  }
}

/**
 * One guarded cycle for a source whose first cleanup has already been manually
 * completed and whose periodic automation was explicitly enabled.
 */
export async function executeAutomaticMusicSourceCleanup(
  userId: string,
  sourcePlaylistId: string,
  now = new Date(),
): Promise<MusicSourceCleanupExecutionResult> {
  const source = await loadManagedMusicSource(userId, sourcePlaylistId);
  if (
    source.musicRetentionMode !== MusicSourceRetentionMode.REMOVE_AFTER_PLAYED ||
    !source.musicCleanupAutomationEnabled ||
    !source.musicCleanupFirstCompletedAt
  ) {
    throw new MusicSourceCleanupError(
      "A limpeza periódica não está autorizada para esta fonte.",
    );
  }

  const preview = await createMusicSourceCleanupPreview(userId, sourcePlaylistId, now);
  return executeMusicSourceCleanupPreview(userId, preview.previewId, now);
}

async function loadManagedMusicSource(userId: string, sourcePlaylistId: string) {
  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id: sourcePlaylistId,
      userId,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
    },
  });
  if (!source) {
    throw new MusicSourceCleanupError("Fonte de música não encontrada.");
  }
  return source;
}

async function readStablePlaylist(
  userId: string,
  playlistId: string,
): Promise<StablePlaylistRead> {
  const accessToken = await getSpotifyAccessToken(userId);
  const [me, before] = await Promise.all([
    spotifyRequest<{ id?: string | null }>(accessToken, "/me"),
    readPlaylistMetadata(accessToken, playlistId),
  ]);

  if (!before.snapshot_id) {
    throw new MusicSourceCleanupError("O Spotify não retornou snapshot da playlist.");
  }
  const ownerId = before.owner?.id ?? null;
  if (ownerId !== me.id && before.collaborative !== true) {
    throw new MusicSourceCleanupPermissionError(
      "A conta conectada não é proprietária nem colaboradora desta playlist.",
    );
  }

  const occurrences: PlaylistCleanupOccurrence[] = [];
  let path: string | null =
    `/playlists/${playlistId}/items?market=from_token&limit=50&fields=next,total,items(is_local,item(id,uri,type,linked_from(id)))`;

  while (path) {
    const page: PlaylistItemsPage = await spotifyRequest(accessToken, path);
    for (const entry of page.items ?? []) {
      const item = entry.item;
      const isTrack = item?.type === "track";
      occurrences.push({
        uri: typeof item?.uri === "string" && item.uri ? item.uri : null,
        aliases: isTrack
          ? spotifyTrackIdentityAliases({
              id: item?.id,
              uri: item?.uri,
              linked_from: item?.linked_from,
            })
          : [],
        isTrack,
        isLocal: entry.is_local === true,
      });
    }
    path = page.next ? stripSpotifyBase(page.next) : null;
  }

  const after = await readPlaylistMetadata(accessToken, playlistId);
  if (!after.snapshot_id || after.snapshot_id !== before.snapshot_id) {
    throw new MusicSourceCleanupStaleError(
      "A playlist mudou enquanto era lida. Gere o preview novamente.",
    );
  }

  return {
    name: after.name ?? before.name ?? "Playlist Spotify",
    snapshotId: after.snapshot_id,
    occurrences,
  };
}

async function readPlaylistMetadata(
  accessToken: string,
  playlistId: string,
): Promise<PlaylistMetadata> {
  return spotifyRequest(
    accessToken,
    `/playlists/${playlistId}?fields=name,snapshot_id,collaborative,owner(id)`,
  );
}

async function diagnoseAfterFailedDelete(
  userId: string,
  playlistId: string,
  plannedUris: string[],
): Promise<{
  snapshotId: string | null;
  removedUris: string[];
  failedUris: string[];
}> {
  try {
    const current = await readStablePlaylist(userId, playlistId);
    const currentUris = new Set(
      current.occurrences
        .map((occurrence) => occurrence.uri)
        .filter((uri): uri is string => Boolean(uri)),
    );
    return {
      snapshotId: current.snapshotId,
      removedUris: plannedUris.filter((uri) => !currentUris.has(uri)),
      failedUris: plannedUris.filter((uri) => currentUris.has(uri)),
    };
  } catch {
    return {
      snapshotId: null,
      removedUris: [],
      failedUris: [...plannedUris],
    };
  }
}

async function spotifyRequest<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  let retries = 0;

  while (true) {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (response.ok) {
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }

    const error = await spotifyApiErrorFromResponse(response, {
      method,
      operation: method === "DELETE" ? "playlist-write" : "playlist-items",
    });
    if (error.kind === "RATE_LIMITED" && retries < MAX_RATE_LIMIT_RETRIES) {
      retries += 1;
      const waitMs =
        Math.max(
          0,
          error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS,
        ) * 1000 + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
      await sleep(waitMs);
      continue;
    }
    throw error;
  }
}

function parseStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function stripSpotifyBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}