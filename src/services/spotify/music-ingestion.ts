import {
  MusicIngestionCapabilityStatus,
  MusicIngestionInitialMode,
  MusicIngestionRuleType,
  MusicIngestionRunStatus,
  MusicIngestionTrigger,
  Prisma,
  SourceKind,
  SpotifySourceType,
  type MusicIngestionRule,
  type SourcePlaylist,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { SpotifyClient } from "@/services/spotify/client";

import {
  createPlaylistRuleState,
  createSavedRuleState,
  parseIngestionRuleState,
  parseSpotifyReference,
  planMusicIngestion,
  playlistNewOccurrences,
  savedTrackNewEvents,
  sortAlbumTracks,
  type IngestionCandidate,
  type IngestionRuleState,
  type MusicIngestionTrack,
  type SavedRuleState,
  type SavedTrackEvent,
} from "./music-ingestion-core";
import {
  canonicalSpotifyTrackId,
  readPlayableMusicCandidate,
  type SpotifyMusicTrackLike,
} from "./music-availability";
import { refreshMusicRepeatContext } from "./recently-played";
import {
  decodeMusicSourceCache,
  patchMusicSourceCacheAfterAppend,
} from "./source-cache";
import {
  isSpotifyApiError,
  spotifyApiErrorFromResponse,
  type SpotifyOperation,
} from "./errors";
import { getSpotifyAccessToken } from "./token";

const API = "https://api.spotify.com/v1";
const BLOCKED_PLAYLIST_MESSAGE =
  "Esta playlist pode ser vista no Spotify, mas o Spotify não permite que o Sonoriza leia seus itens pela API atual.";
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 1;
const RETRY_JITTER_MAX_MS = 250;

export type CreateMusicIngestionRuleInput = {
  targetSourcePlaylistId: string;
  type: MusicIngestionRuleType;
  sourceSpotifyId?: string | null;
  initialMode: MusicIngestionInitialMode;
};

export type SyncMusicIngestionOptions = {
  preview?: boolean;
  allowInitialImport?: boolean;
  trigger?: MusicIngestionTrigger;
};

export type MusicIngestionSyncResult = {
  ruleId: string | null;
  status: MusicIngestionRunStatus;
  sourceEventCount: number;
  addedCount: number;
  duplicateCount: number;
  cooldownCount: number;
  unavailableCount: number;
};

export type ManualMusicIngestionInput = {
  targetSourcePlaylistId: string;
  reference: string;
  preferredType: "track" | "album";
  preview?: boolean;
};

type RuleWithTarget = MusicIngestionRule & { target: SourcePlaylist };

type PlaylistMetadata = {
  id: string;
  name: string;
  snapshotId: string;
  ownerId: string | null;
  collaborative: boolean;
};

type PlaylistReadResult = {
  metadata: PlaylistMetadata;
  tracks: MusicIngestionTrack[];
  unavailableCount: number;
};

type TargetTrackIndex = {
  trackIds: Set<string>;
  cacheSnapshotId: string | null;
  cacheValue: unknown;
};

type PlaylistWriteResult = {
  acceptedUris: string[];
  snapshotId: string | null;
};

export class MusicIngestionPartialWriteError extends Error {
  readonly acceptedUris: string[];
  readonly snapshotId: string | null;
  readonly causeError: unknown;

  constructor(acceptedUris: string[], snapshotId: string | null, causeError: unknown) {
    super(`Spotify accepted ${acceptedUris.length} item(s) before a later ingestion batch failed.`);
    this.name = "MusicIngestionPartialWriteError";
    this.acceptedUris = acceptedUris;
    this.snapshotId = snapshotId;
    this.causeError = causeError;
  }
}

class MusicIngestionSpotifyApi {
  private constructor(private readonly accessToken: string) {}

  static async forUser(userId: string): Promise<MusicIngestionSpotifyApi> {
    return new MusicIngestionSpotifyApi(await getSpotifyAccessToken(userId));
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    operation: SpotifyOperation = "spotify-api",
  ): Promise<T> {
    let retries = 0;
    const method = (init.method ?? "GET").toUpperCase();

    while (true) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return (await response.json()) as T;
      }

      const error = await spotifyApiErrorFromResponse(response, { method, operation });
      if (error.kind === "RATE_LIMITED" && retries < MAX_RATE_LIMIT_RETRIES) {
        retries += 1;
        const waitMs =
          Math.max(0, error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS) * 1000 +
          Math.floor(Math.random() * (RETRY_JITTER_MAX_MS + 1));
        await sleep(waitMs);
        continue;
      }
      throw error;
    }
  }

  async getCurrentUserId(): Promise<string> {
    const me = await this.request<{ id: string }>("/me", {}, "current-user");
    return me.id;
  }

  async getPlaylistMetadata(playlistId: string): Promise<PlaylistMetadata> {
    const playlist = await this.request<{
      id: string;
      name: string;
      snapshot_id: string;
      collaborative?: boolean;
      owner?: { id?: string };
    }>(
      `/playlists/${encodeURIComponent(playlistId)}?fields=id,name,snapshot_id,collaborative,owner(id)`,
      {},
      "playlist-metadata",
    );
    if (!playlist.id || !playlist.snapshot_id) {
      throw new Error(`Spotify playlist ${playlistId} returned incomplete metadata.`);
    }
    return {
      id: playlist.id,
      name: playlist.name,
      snapshotId: playlist.snapshot_id,
      ownerId: playlist.owner?.id ?? null,
      collaborative: Boolean(playlist.collaborative),
    };
  }

  async assertPlaylistWritable(playlistId: string): Promise<PlaylistMetadata> {
    const [metadata, spotifyUserId] = await Promise.all([
      this.getPlaylistMetadata(playlistId),
      this.getCurrentUserId(),
    ]);
    if (metadata.ownerId !== spotifyUserId && !metadata.collaborative) {
      throw new Error(
        `A playlist ${metadata.name || playlistId} não é gravável pela conta Spotify conectada.`,
      );
    }
    return metadata;
  }

  async probePlaylistReadable(playlistId: string): Promise<{
    status: MusicIngestionCapabilityStatus;
    message: string | null;
    name: string | null;
  }> {
    let name: string | null = null;
    try {
      const metadata = await this.getPlaylistMetadata(playlistId);
      name = metadata.name;
      await this.request(
        `/playlists/${encodeURIComponent(playlistId)}/items?limit=1&fields=items(item(id,uri,type)),next`,
        {},
        "playlist-items",
      );
      return {
        status: MusicIngestionCapabilityStatus.SUPPORTED,
        message: null,
        name,
      };
    } catch (error) {
      if (isSpotifyApiError(error) && error.status === 403) {
        return {
          status: MusicIngestionCapabilityStatus.BLOCKED,
          message: BLOCKED_PLAYLIST_MESSAGE,
          name,
        };
      }
      throw error;
    }
  }

  async readPlaylistTracks(playlistId: string): Promise<PlaylistReadResult> {
    const before = await this.getPlaylistMetadata(playlistId);
    const tracks: MusicIngestionTrack[] = [];
    let unavailableCount = 0;
    let next: string | null =
      `/playlists/${encodeURIComponent(playlistId)}/items?market=from_token&limit=50&fields=next,items(item(id,uri,name,duration_ms,is_local,type,is_playable,restrictions(reason),linked_from(id),artists(name)))`;

    while (next) {
      const page: SpotifyPage<{ item: SpotifyTrackResponse | null }> = await this.request(
        next,
        {},
        "playlist-items",
      );
      for (const item of page.items ?? []) {
        const converted = toMusicIngestionTrack(item.item);
        if (converted.unavailable) unavailableCount += 1;
        if (converted.track) tracks.push(converted.track);
      }
      next = page.next ? stripBase(page.next) : null;
    }

    const after = await this.getPlaylistMetadata(playlistId);
    if (before.snapshotId !== after.snapshotId) {
      throw new Error(
        `Spotify playlist ${playlistId} changed while MUSIC-03 was reading it; state was not advanced.`,
      );
    }
    return { metadata: after, tracks, unavailableCount };
  }

  async readSavedBoundary(): Promise<SavedTrackEvent[]> {
    const events: SavedTrackEvent[] = [];
    let next: string | null = "/me/tracks?market=from_token&limit=50";
    let newestAddedAt: string | null = null;

    while (next) {
      const page: SpotifyPage<SavedTrackItemResponse> = await this.request(next);
      let reachedOlder = false;
      for (const item of page.items ?? []) {
        const event = toSavedTrackEvent(item);
        if (!event) continue;
        if (!newestAddedAt) newestAddedAt = event.addedAt;
        if (event.addedAt !== newestAddedAt) {
          reachedOlder = true;
          break;
        }
        events.push(event);
      }
      if (reachedOlder || !page.next) break;
      next = stripBase(page.next);
    }
    return events;
  }

  async readSavedEvents(previous: SavedRuleState | null): Promise<SavedTrackEvent[]> {
    const events: SavedTrackEvent[] = [];
    let next: string | null = "/me/tracks?market=from_token&limit=50";

    while (next) {
      const page: SpotifyPage<SavedTrackItemResponse> = await this.request(next);
      let reachedOlder = false;
      for (const item of page.items ?? []) {
        const event = toSavedTrackEvent(item);
        if (!event) continue;
        if (previous?.watermarkAddedAt && event.addedAt < previous.watermarkAddedAt) {
          reachedOlder = true;
          break;
        }
        events.push(event);
      }
      if (reachedOlder || !page.next) break;
      next = stripBase(page.next);
    }
    return events;
  }

  async readAlbumTracks(albumId: string): Promise<{
    albumId: string;
    tracks: MusicIngestionTrack[];
    unavailableCount: number;
  }> {
    const album = await this.request<{ id: string; album_type?: string }>(
      `/albums/${encodeURIComponent(albumId)}?market=from_token`,
    );
    const tracks: MusicIngestionTrack[] = [];
    let unavailableCount = 0;
    let next: string | null = `/albums/${encodeURIComponent(albumId)}/tracks?market=from_token&limit=50`;

    while (next) {
      const page: SpotifyPage<SpotifyTrackResponse> = await this.request(next);
      for (const raw of page.items ?? []) {
        const converted = toMusicIngestionTrack(raw, {
          albumId: album.id,
          albumType: album.album_type ?? undefined,
        });
        if (converted.unavailable) unavailableCount += 1;
        if (converted.track) tracks.push(converted.track);
      }
      next = page.next ? stripBase(page.next) : null;
    }

    return {
      albumId: album.id,
      tracks: sortAlbumTracks(tracks),
      unavailableCount,
    };
  }

  async resolveManualReference(
    value: string,
    preferredType: "track" | "album",
  ): Promise<{ tracks: MusicIngestionTrack[]; unavailableCount: number; originAlbumId?: string }> {
    const parsed = parseSpotifyReference(value);
    const type = parsed?.type ?? preferredType;
    let id = parsed?.id ?? null;

    if (!id) {
      const q = encodeURIComponent(value.trim());
      if (!q) throw new Error("Informe uma música, álbum, URL ou URI Spotify.");
      if (type === "track") {
        const search = await this.request<{ tracks?: { items?: SpotifyTrackResponse[] } }>(
          `/search?q=${q}&type=track&market=from_token&limit=1`,
        );
        id = search.tracks?.items?.[0]?.id ?? null;
      } else {
        const search = await this.request<{ albums?: { items?: Array<{ id?: string }> } }>(
          `/search?q=${q}&type=album&market=from_token&limit=1`,
        );
        id = search.albums?.items?.[0]?.id ?? null;
      }
    }
    if (!id) throw new Error("O Spotify não encontrou o item informado.");

    if (type === "album") {
      const album = await this.readAlbumTracks(id);
      return {
        tracks: album.tracks,
        unavailableCount: album.unavailableCount,
        originAlbumId: album.albumId,
      };
    }

    const raw = await this.request<SpotifyTrackResponse>(
      `/tracks/${encodeURIComponent(id)}?market=from_token`,
    );
    const converted = toMusicIngestionTrack(raw);
    if (!converted.track) {
      return { tracks: [], unavailableCount: converted.unavailable ? 1 : 0 };
    }
    return { tracks: [converted.track], unavailableCount: 0 };
  }

  async addPlaylistItems(playlistId: string, uris: string[]): Promise<PlaylistWriteResult> {
    const acceptedUris: string[] = [];
    let snapshotId: string | null = null;
    for (const batch of chunk(uris, 100)) {
      try {
        const result = await this.request<{ snapshot_id?: string | null }>(
          `/playlists/${encodeURIComponent(playlistId)}/items`,
          { method: "POST", body: JSON.stringify({ uris: batch }) },
          "playlist-write",
        );
        acceptedUris.push(...batch);
        snapshotId = result.snapshot_id ?? snapshotId;
      } catch (error) {
        throw new MusicIngestionPartialWriteError(acceptedUris, snapshotId, error);
      }
    }
    return { acceptedUris, snapshotId };
  }
}

export async function createMusicIngestionRule(
  userId: string,
  input: CreateMusicIngestionRuleInput,
): Promise<MusicIngestionRule> {
  const target = await loadTargetInbox(userId, input.targetSourcePlaylistId);
  const sourceSpotifyId = input.sourceSpotifyId?.trim() || null;
  if (input.type === MusicIngestionRuleType.PLAYLIST_COPY && !sourceSpotifyId) {
    throw new Error("PLAYLIST_COPY exige uma playlist Spotify de origem.");
  }
  if (sourceSpotifyId && sourceSpotifyId === target.spotifyId) {
    throw new Error("A playlist de origem e a inbox de destino precisam ser diferentes.");
  }

  const existing = await prisma.musicIngestionRule.findFirst({
    where: {
      userId,
      targetSourcePlaylistId: target.id,
      type: input.type,
      sourceSpotifyId,
    },
  });
  if (existing) throw new Error("Esta regra de alimentação já existe para a inbox escolhida.");

  const api = await MusicIngestionSpotifyApi.forUser(userId);
  await api.assertPlaylistWritable(target.spotifyId);

  let capabilityStatus: MusicIngestionCapabilityStatus =
    MusicIngestionCapabilityStatus.SUPPORTED;
  let capabilityMessage: string | null = null;
  let sourceName: string | null = null;
  if (input.type === MusicIngestionRuleType.PLAYLIST_COPY && sourceSpotifyId) {
    const probe = await api.probePlaylistReadable(sourceSpotifyId);
    capabilityStatus = probe.status;
    capabilityMessage = probe.message;
    sourceName = probe.name;
  }

  const rule = await prisma.musicIngestionRule.create({
    data: {
      userId,
      targetSourcePlaylistId: target.id,
      type: input.type,
      sourceSpotifyId,
      sourceName,
      enabled: false,
      initialMode: input.initialMode,
      capabilityStatus,
      capabilityMessage,
    },
  });

  if (capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED) return rule;
  if (input.initialMode === MusicIngestionInitialMode.FROM_NOW) {
    return initializeRuleFromNow(userId, rule.id, api);
  }
  return rule;
}

async function initializeRuleFromNow(
  userId: string,
  ruleId: string,
  existingApi?: MusicIngestionSpotifyApi,
): Promise<MusicIngestionRule> {
  const rule = await loadRule(userId, ruleId);
  const api = existingApi ?? (await MusicIngestionSpotifyApi.forUser(userId));
  const startedAt = new Date();
  let state: IngestionRuleState;
  let unavailableCount = 0;

  if (rule.type === MusicIngestionRuleType.PLAYLIST_COPY) {
    if (!rule.sourceSpotifyId) throw new Error("PLAYLIST_COPY sem sourceSpotifyId.");
    const read = await api.readPlaylistTracks(rule.sourceSpotifyId);
    state = createPlaylistRuleState(read.metadata.snapshotId, read.tracks);
    unavailableCount = read.unavailableCount;
  } else {
    const events = await api.readSavedBoundary();
    state = createSavedRuleState(rule.type, events);
  }

  const now = new Date();
  const updated = await prisma.musicIngestionRule.update({
    where: { id: rule.id },
    data: {
      state: asJson(state),
      enabled: true,
      capabilityStatus: MusicIngestionCapabilityStatus.SUPPORTED,
      capabilityMessage: null,
      lastSyncAt: now,
      lastSuccessAt: now,
    },
  });
  await prisma.musicIngestionRun.create({
    data: {
      userId,
      ruleId: rule.id,
      targetSourcePlaylistId: rule.targetSourcePlaylistId,
      ruleType: rule.type,
      trigger: MusicIngestionTrigger.INITIAL_BASELINE,
      status: MusicIngestionRunStatus.NOOP,
      preview: false,
      sourceEventCount: 0,
      unavailableCount,
      startedAt,
      finishedAt: now,
      details: asJson({
        version: 1,
        mode: "FROM_NOW",
        message: "Baseline registrada sem escrever no Spotify; somente eventos futuros serão processados.",
      }),
    },
  });
  return updated;
}

export async function syncMusicIngestionRule(
  userId: string,
  ruleId: string,
  options: SyncMusicIngestionOptions = {},
): Promise<MusicIngestionSyncResult> {
  const preview = options.preview === true;
  const allowInitialImport = options.allowInitialImport === true;
  const rule = await loadRule(userId, ruleId);
  if (!rule.enabled && !(allowInitialImport && rule.initialMode === MusicIngestionInitialMode.IMPORT_CURRENT)) {
    throw new Error("Esta regra está desativada ou ainda aguarda importação inicial explícita.");
  }
  if (rule.capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED) {
    throw new Error(rule.capabilityMessage ?? BLOCKED_PLAYLIST_MESSAGE);
  }

  const startedAt = new Date();
  const trigger =
    options.trigger ??
    (allowInitialImport
      ? MusicIngestionTrigger.INITIAL_IMPORT
      : MusicIngestionTrigger.USER_SYNC);
  const api = await MusicIngestionSpotifyApi.forUser(userId);

  try {
    const collected = await collectRuleEvents(rule, api, allowInitialImport);
    let targetIndex: TargetTrackIndex = {
      trackIds: new Set<string>(),
      cacheSnapshotId: null,
      cacheValue: null,
    };
    let blockedTrackIds = new Set<string>();

    if (collected.incoming.length > 0) {
      targetIndex = await loadTargetTrackIds(rule.target);
      const repeat = await refreshMusicRepeatContext(userId, new Date());
      blockedTrackIds = new Set(repeat.context.blockedTrackIds);
    }

    const plan = planMusicIngestion(
      collected.incoming,
      targetIndex.trackIds,
      blockedTrackIds,
    );
    const details = buildRunDetails(
      collected.sourceEventCount,
      plan,
      collected.unavailableCount,
    );

    if (preview) {
      await prisma.musicIngestionRun.create({
        data: {
          userId,
          ruleId: rule.id,
          targetSourcePlaylistId: rule.targetSourcePlaylistId,
          ruleType: rule.type,
          trigger,
          status: MusicIngestionRunStatus.PREVIEW,
          preview: true,
          sourceEventCount: collected.sourceEventCount,
          addedCount: plan.add.length,
          duplicateCount: plan.duplicate.length,
          cooldownCount: plan.cooldown.length,
          unavailableCount: collected.unavailableCount,
          details: asJson(details),
          startedAt,
          finishedAt: new Date(),
        },
      });
      return resultFor(
        rule.id,
        MusicIngestionRunStatus.PREVIEW,
        collected.sourceEventCount,
        plan.add.length,
        plan.duplicate.length,
        plan.cooldown.length,
        collected.unavailableCount,
      );
    }

    const writableTarget = await api.assertPlaylistWritable(rule.target.spotifyId);
    let acceptedUris: string[] = [];
    let writeSnapshotId: string | null = null;
    try {
      const write = await api.addPlaylistItems(
        rule.target.spotifyId,
        plan.add.map((item) => item.track.uri),
      );
      acceptedUris = write.acceptedUris;
      writeSnapshotId = write.snapshotId;
    } catch (error) {
      if (error instanceof MusicIngestionPartialWriteError) {
        acceptedUris = error.acceptedUris;
        if (acceptedUris.length > 0) {
          await maintainTargetCacheAfterAppend(
            rule.target,
            targetIndex.cacheSnapshotId === writableTarget.snapshotId
              ? writableTarget.snapshotId
              : null,
            error.snapshotId,
            targetIndex.cacheValue,
            plan.add.slice(0, acceptedUris.length).map((item) => item.track),
          );
        }
        await prisma.musicIngestionRun.create({
          data: {
            userId,
            ruleId: rule.id,
            targetSourcePlaylistId: rule.targetSourcePlaylistId,
            ruleType: rule.type,
            trigger,
            status: MusicIngestionRunStatus.PARTIAL,
            preview: false,
            sourceEventCount: collected.sourceEventCount,
            addedCount: acceptedUris.length,
            duplicateCount: plan.duplicate.length,
            cooldownCount: plan.cooldown.length,
            unavailableCount: collected.unavailableCount,
            details: asJson({ ...details, acceptedUris }),
            startedAt,
            finishedAt: new Date(),
            error: errorText(error.causeError),
          },
        });
        throw error;
      }
      throw error;
    }

    if (acceptedUris.length > 0) {
      await maintainTargetCacheAfterAppend(
        rule.target,
        targetIndex.cacheSnapshotId === writableTarget.snapshotId
          ? writableTarget.snapshotId
          : null,
        writeSnapshotId,
        targetIndex.cacheValue,
        plan.add.slice(0, acceptedUris.length).map((item) => item.track),
      );
    }
    const finishedAt = new Date();
    const status =
      acceptedUris.length > 0
        ? MusicIngestionRunStatus.SUCCESS
        : MusicIngestionRunStatus.NOOP;

    await prisma.$transaction([
      prisma.musicIngestionRule.update({
        where: { id: rule.id },
        data: {
          state: asJson(collected.nextState),
          enabled: true,
          capabilityStatus: MusicIngestionCapabilityStatus.SUPPORTED,
          capabilityMessage: null,
          lastSyncAt: finishedAt,
          lastSuccessAt: finishedAt,
        },
      }),
      prisma.musicIngestionRun.create({
        data: {
          userId,
          ruleId: rule.id,
          targetSourcePlaylistId: rule.targetSourcePlaylistId,
          ruleType: rule.type,
          trigger,
          status,
          preview: false,
          sourceEventCount: collected.sourceEventCount,
          addedCount: acceptedUris.length,
          duplicateCount: plan.duplicate.length,
          cooldownCount: plan.cooldown.length,
          unavailableCount: collected.unavailableCount,
          details: asJson({ ...details, acceptedUris }),
          startedAt,
          finishedAt,
        },
      }),
    ]);

    return resultFor(
      rule.id,
      status,
      collected.sourceEventCount,
      acceptedUris.length,
      plan.duplicate.length,
      plan.cooldown.length,
      collected.unavailableCount,
    );
  } catch (error) {
    if (
      rule.type === MusicIngestionRuleType.PLAYLIST_COPY &&
      isSpotifyApiError(error) &&
      error.status === 403
    ) {
      await prisma.musicIngestionRule.update({
        where: { id: rule.id },
        data: {
          enabled: false,
          capabilityStatus: MusicIngestionCapabilityStatus.BLOCKED,
          capabilityMessage: BLOCKED_PLAYLIST_MESSAGE,
          lastSyncAt: new Date(),
        },
      });
    }

    if (!(error instanceof MusicIngestionPartialWriteError)) {
      await prisma.musicIngestionRun.create({
        data: {
          userId,
          ruleId: rule.id,
          targetSourcePlaylistId: rule.targetSourcePlaylistId,
          ruleType: rule.type,
          trigger,
          status: MusicIngestionRunStatus.FAILED,
          preview,
          startedAt,
          finishedAt: new Date(),
          error: errorText(error),
        },
      });
    }
    throw error;
  }
}

export async function runManualMusicIngestion(
  userId: string,
  input: ManualMusicIngestionInput,
): Promise<MusicIngestionSyncResult> {
  const target = await loadTargetInbox(userId, input.targetSourcePlaylistId);
  const api = await MusicIngestionSpotifyApi.forUser(userId);
  const startedAt = new Date();

  try {
    const resolved = await api.resolveManualReference(input.reference, input.preferredType);
    const incoming: IngestionCandidate[] = resolved.tracks.map((track) => ({
      track,
      origin: {
        kind: "MANUAL",
        ...(resolved.originAlbumId ? { albumId: resolved.originAlbumId } : {}),
      },
    }));
    const targetIndex =
      incoming.length > 0
        ? await loadTargetTrackIds(target)
        : { trackIds: new Set<string>(), cacheSnapshotId: null, cacheValue: null };
    const repeat =
      incoming.length > 0 ? await refreshMusicRepeatContext(userId, new Date()) : null;
    const plan = planMusicIngestion(
      incoming,
      targetIndex.trackIds,
      repeat?.context.blockedTrackIds ?? new Set<string>(),
    );
    const preview = input.preview === true;
    const details = buildRunDetails(1, plan, resolved.unavailableCount);

    if (preview) {
      await prisma.musicIngestionRun.create({
        data: {
          userId,
          targetSourcePlaylistId: target.id,
          trigger: MusicIngestionTrigger.MANUAL,
          status: MusicIngestionRunStatus.PREVIEW,
          preview: true,
          sourceEventCount: 1,
          addedCount: plan.add.length,
          duplicateCount: plan.duplicate.length,
          cooldownCount: plan.cooldown.length,
          unavailableCount: resolved.unavailableCount,
          details: asJson(details),
          startedAt,
          finishedAt: new Date(),
        },
      });
      return resultFor(
        null,
        MusicIngestionRunStatus.PREVIEW,
        1,
        plan.add.length,
        plan.duplicate.length,
        plan.cooldown.length,
        resolved.unavailableCount,
      );
    }

    const writableTarget = await api.assertPlaylistWritable(target.spotifyId);
    let acceptedUris: string[] = [];
    let writeSnapshotId: string | null = null;
    try {
      const write = await api.addPlaylistItems(
        target.spotifyId,
        plan.add.map((candidate) => candidate.track.uri),
      );
      acceptedUris = write.acceptedUris;
      writeSnapshotId = write.snapshotId;
    } catch (error) {
      if (error instanceof MusicIngestionPartialWriteError) {
        acceptedUris = error.acceptedUris;
        if (acceptedUris.length > 0) {
          await maintainTargetCacheAfterAppend(
            target,
            targetIndex.cacheSnapshotId === writableTarget.snapshotId
              ? writableTarget.snapshotId
              : null,
            error.snapshotId,
            targetIndex.cacheValue,
            plan.add.slice(0, acceptedUris.length).map((item) => item.track),
          );
        }
        await prisma.musicIngestionRun.create({
          data: {
            userId,
            targetSourcePlaylistId: target.id,
            trigger: MusicIngestionTrigger.MANUAL,
            status: MusicIngestionRunStatus.PARTIAL,
            preview: false,
            sourceEventCount: 1,
            addedCount: acceptedUris.length,
            duplicateCount: plan.duplicate.length,
            cooldownCount: plan.cooldown.length,
            unavailableCount: resolved.unavailableCount,
            details: asJson({ ...details, acceptedUris }),
            startedAt,
            finishedAt: new Date(),
            error: errorText(error.causeError),
          },
        });
        throw error;
      }
      throw error;
    }

    if (acceptedUris.length > 0) {
      await maintainTargetCacheAfterAppend(
        target,
        targetIndex.cacheSnapshotId === writableTarget.snapshotId
          ? writableTarget.snapshotId
          : null,
        writeSnapshotId,
        targetIndex.cacheValue,
        plan.add.slice(0, acceptedUris.length).map((item) => item.track),
      );
    }
    const status =
      acceptedUris.length > 0
        ? MusicIngestionRunStatus.SUCCESS
        : MusicIngestionRunStatus.NOOP;
    await prisma.musicIngestionRun.create({
      data: {
        userId,
        targetSourcePlaylistId: target.id,
        trigger: MusicIngestionTrigger.MANUAL,
        status,
        preview: false,
        sourceEventCount: 1,
        addedCount: acceptedUris.length,
        duplicateCount: plan.duplicate.length,
        cooldownCount: plan.cooldown.length,
        unavailableCount: resolved.unavailableCount,
        details: asJson({ ...details, acceptedUris }),
        startedAt,
        finishedAt: new Date(),
      },
    });
    return resultFor(
      null,
      status,
      1,
      acceptedUris.length,
      plan.duplicate.length,
      plan.cooldown.length,
      resolved.unavailableCount,
    );
  } catch (error) {
    if (!(error instanceof MusicIngestionPartialWriteError)) {
      await prisma.musicIngestionRun.create({
        data: {
          userId,
          targetSourcePlaylistId: target.id,
          trigger: MusicIngestionTrigger.MANUAL,
          status: MusicIngestionRunStatus.FAILED,
          preview: input.preview === true,
          startedAt,
          finishedAt: new Date(),
          error: errorText(error),
        },
      });
    }
    throw error;
  }
}

export async function setMusicIngestionRuleEnabled(
  userId: string,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  const rule = await prisma.musicIngestionRule.findFirst({ where: { id: ruleId, userId } });
  if (!rule) throw new Error("Regra de alimentação não encontrada.");
  if (enabled && rule.capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED) {
    throw new Error(rule.capabilityMessage ?? BLOCKED_PLAYLIST_MESSAGE);
  }
  if (enabled && !parseIngestionRuleState(rule.state)) {
    throw new Error("A regra ainda precisa concluir sua ativação inicial antes de ser habilitada.");
  }
  await prisma.musicIngestionRule.update({ where: { id: rule.id }, data: { enabled } });
}

export async function deleteMusicIngestionRule(userId: string, ruleId: string): Promise<void> {
  const result = await prisma.musicIngestionRule.deleteMany({ where: { id: ruleId, userId } });
  if (result.count !== 1) throw new Error("Regra de alimentação não encontrada.");
}

async function collectRuleEvents(
  rule: RuleWithTarget,
  api: MusicIngestionSpotifyApi,
  allowInitialImport: boolean,
): Promise<{
  incoming: IngestionCandidate[];
  nextState: IngestionRuleState;
  sourceEventCount: number;
  unavailableCount: number;
}> {
  const rawState = parseIngestionRuleState(rule.state);

  if (rule.type === MusicIngestionRuleType.PLAYLIST_COPY) {
    if (!rule.sourceSpotifyId) throw new Error("PLAYLIST_COPY sem sourceSpotifyId.");
    const previous = rawState?.kind === "PLAYLIST_COPY" ? rawState : null;
    const metadata = await api.getPlaylistMetadata(rule.sourceSpotifyId);
    if (previous && previous.snapshotId === metadata.snapshotId) {
      return {
        incoming: [],
        nextState: previous,
        sourceEventCount: 0,
        unavailableCount: 0,
      };
    }
    const read = await api.readPlaylistTracks(rule.sourceSpotifyId);
    const newTracks =
      previous || allowInitialImport ? playlistNewOccurrences(previous, read.tracks) : [];
    return {
      incoming: newTracks.map((track) => ({
        track,
        origin: { kind: "PLAYLIST_COPY", sourceSpotifyId: rule.sourceSpotifyId! },
      })),
      nextState: createPlaylistRuleState(read.metadata.snapshotId, read.tracks),
      sourceEventCount: newTracks.length,
      unavailableCount: read.unavailableCount,
    };
  }

  const expectedKind = rule.type;
  const previous = rawState?.kind === expectedKind ? rawState : null;
  const observed = await api.readSavedEvents(previous);
  const events = previous || allowInitialImport ? savedTrackNewEvents(previous, observed) : [];
  const nextState = createSavedRuleState(expectedKind, observed, previous);
  let unavailableCount = 0;
  const incoming: IngestionCandidate[] = [];

  if (rule.type === MusicIngestionRuleType.SAVED_TRACK) {
    for (const event of events) {
      incoming.push({
        track: event.track,
        origin: {
          kind: "SAVED_TRACK",
          eventTrackId: event.track.spotifyTrackId,
          eventAddedAt: event.addedAt,
        },
      });
    }
  } else {
    for (const event of events) {
      if (!event.track.albumId) {
        unavailableCount += 1;
        continue;
      }
      const album = await api.readAlbumTracks(event.track.albumId);
      unavailableCount += album.unavailableCount;
      for (const track of album.tracks) {
        incoming.push({
          track,
          origin: {
            kind: "SAVED_TRACK_ALBUM",
            eventTrackId: event.track.spotifyTrackId,
            eventAddedAt: event.addedAt,
            albumId: album.albumId,
          },
        });
      }
    }
  }

  return {
    incoming,
    nextState,
    sourceEventCount: events.length,
    unavailableCount,
  };
}

async function loadRule(userId: string, ruleId: string): Promise<RuleWithTarget> {
  const rule = await prisma.musicIngestionRule.findFirst({
    where: { id: ruleId, userId },
    include: { target: true },
  });
  if (!rule) throw new Error("Regra de alimentação não encontrada.");
  if (
    rule.target.userId !== userId ||
    rule.target.kind !== SourceKind.MUSIC ||
    rule.target.spotifyType !== SpotifySourceType.PLAYLIST
  ) {
    throw new Error("A inbox configurada não é uma playlist de música válida.");
  }
  return rule;
}

async function loadTargetInbox(userId: string, id: string): Promise<SourcePlaylist> {
  const target = await prisma.sourcePlaylist.findFirst({
    where: {
      id,
      userId,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
    },
  });
  if (!target) throw new Error("Playlist-inbox não encontrada.");
  return target;
}

async function loadTargetTrackIds(
  target: SourcePlaylist,
): Promise<TargetTrackIndex> {
  const spotifyClient = await SpotifyClient.forUser(target.userId);
  const candidates = await spotifyClient.getPlaylistTracks(target.spotifyId);
  const refreshed = await prisma.sourcePlaylist.findUnique({
    where: { id: target.id },
    select: { spotifySnapshotId: true, cachedCandidates: true },
  });
  const refreshedCache =
    refreshed?.spotifySnapshotId
      ? decodeMusicSourceCache(refreshed.cachedCandidates)
      : null;

  if (refreshed?.spotifySnapshotId && refreshedCache) {
    return {
      trackIds: new Set(
        refreshedCache.flatMap((candidate) =>
          candidate.spotifyTrackId ? [candidate.spotifyTrackId] : [],
        ),
      ),
      cacheSnapshotId: refreshed.spotifySnapshotId,
      cacheValue: refreshed.cachedCandidates,
    };
  }

  return {
    trackIds: new Set(
      candidates.flatMap((candidate) =>
        candidate.spotifyTrackId ? [candidate.spotifyTrackId] : [],
      ),
    ),
    cacheSnapshotId: null,
    cacheValue: null,
  };
}

async function maintainTargetCacheAfterAppend(
  target: SourcePlaylist,
  baseSnapshotId: string | null,
  nextSnapshotId: string | null,
  cacheValue: unknown,
  tracks: MusicIngestionTrack[],
): Promise<void> {
  if (!baseSnapshotId || !nextSnapshotId) {
    if (baseSnapshotId) await invalidateTargetCache(target.id, baseSnapshotId);
    return;
  }

  const patched = patchMusicSourceCacheAfterAppend(
    cacheValue,
    tracks.map((track) => ({
      uri: track.uri,
      spotifyTrackId: track.spotifyTrackId,
      type: "MUSIC" as const,
      title: track.title,
      ...(track.subtitle ? { subtitle: track.subtitle } : {}),
      durationMs: track.durationMs,
    })),
  );
  if (!patched) {
    await invalidateTargetCache(target.id, baseSnapshotId);
    return;
  }

  await prisma.sourcePlaylist.updateMany({
    where: { id: target.id, spotifySnapshotId: baseSnapshotId },
    data: {
      spotifySnapshotId: nextSnapshotId,
      cachedCandidates: asJson(patched),
      cacheUpdatedAt: new Date(),
    },
  });
}

async function invalidateTargetCache(
  sourcePlaylistId: string,
  expectedSnapshotId: string | null = null,
): Promise<void> {
  const data = {
    spotifySnapshotId: null,
    cachedCandidates: Prisma.DbNull,
    cacheUpdatedAt: null,
  };
  if (expectedSnapshotId) {
    await prisma.sourcePlaylist.updateMany({
      where: { id: sourcePlaylistId, spotifySnapshotId: expectedSnapshotId },
      data,
    });
    return;
  }
  await prisma.sourcePlaylist.update({ where: { id: sourcePlaylistId }, data });
}

function toSavedTrackEvent(item: SavedTrackItemResponse): SavedTrackEvent | null {
  if (typeof item.added_at !== "string" || !item.added_at) return null;
  const converted = toMusicIngestionTrack(item.track, {
    albumId: item.track?.album?.id,
    albumType: item.track?.album?.album_type,
  });
  if (!converted.track) return null;
  return { addedAt: item.added_at, track: converted.track };
}

function toMusicIngestionTrack(
  raw: SpotifyTrackResponse | null | undefined,
  albumOverride: { albumId?: string; albumType?: string } = {},
): { track: MusicIngestionTrack | null; unavailable: boolean } {
  if (!raw) return { track: null, unavailable: false };
  const result = readPlayableMusicCandidate(raw);
  if (!result.candidate) return { track: null, unavailable: result.unavailable };
  const spotifyTrackId = result.candidate.spotifyTrackId ?? canonicalSpotifyTrackId(raw);
  if (!spotifyTrackId) return { track: null, unavailable: false };
  return {
    track: {
      spotifyTrackId,
      uri: result.candidate.uri,
      title: result.candidate.title,
      subtitle: result.candidate.subtitle,
      durationMs: result.candidate.durationMs,
      albumId: albumOverride.albumId ?? raw.album?.id,
      albumType: albumOverride.albumType ?? raw.album?.album_type,
      discNumber: raw.disc_number,
      trackNumber: raw.track_number,
    },
    unavailable: false,
  };
}

function buildRunDetails(
  sourceEventCount: number,
  plan: ReturnType<typeof planMusicIngestion>,
  unavailableCount: number,
) {
  const item = (candidate: IngestionCandidate, reason: string) => ({
    spotifyTrackId: candidate.track.spotifyTrackId,
    uri: candidate.track.uri,
    title: candidate.track.title,
    reason,
    origin: candidate.origin,
  });
  return {
    version: 1,
    sourceEventCount,
    unavailableCount,
    added: plan.add.map((candidate) => item(candidate, "eligible")),
    duplicates: plan.duplicate.map((candidate) => item(candidate, "already_in_inbox_or_batch")),
    cooldown: plan.cooldown.map((candidate) => item(candidate, "music_01_cooldown")),
  };
}

function resultFor(
  ruleId: string | null,
  status: MusicIngestionRunStatus,
  sourceEventCount: number,
  addedCount: number,
  duplicateCount: number,
  cooldownCount: number,
  unavailableCount: number,
): MusicIngestionSyncResult {
  return {
    ruleId,
    status,
    sourceEventCount,
    addedCount,
    duplicateCount,
    cooldownCount,
    unavailableCount,
  };
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
}

interface SpotifyTrackResponse extends SpotifyMusicTrackLike {
  id?: string | null;
  disc_number?: number;
  track_number?: number;
  album?: { id?: string; album_type?: string } | null;
}

interface SavedTrackItemResponse {
  added_at?: string | null;
  track?: SpotifyTrackResponse | null;
}

function stripBase(url: string): string {
  return url.startsWith(API) ? url.slice(API.length) : url;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
