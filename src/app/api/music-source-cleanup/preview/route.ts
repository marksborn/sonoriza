import {
  MusicSourceCleanupStatus,
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
  type Prisma,
} from "@prisma/client";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";
import {
  createMusicSourceCleanupPreview,
  MusicSourceCleanupHistoryRequiredError,
} from "@/services/spotify/source-cleanup";
import { buildAuditedCacheFallbackPlan } from "@/services/spotify/source-cleanup-audited-fallback";
import { decodeMusicSourceCache } from "@/services/spotify/source-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RECENT_PREVIEW_REUSE_MS = 10 * 60 * 1000;
const inFlightPreviews = new Map<string, Promise<string>>();

function isPlaylistReadQuotaExceeded(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "kind" in error &&
      "operation" in error &&
      (error as { kind?: unknown }).kind === "QUOTA_EXCEEDED" &&
      (error as { operation?: unknown }).operation === "playlist-items",
  );
}

function parseStringArray(value: Prisma.JsonValue): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === "string")) return null;
  return value;
}

async function createAuditedCacheFallbackPreview(
  userId: string,
  sourcePlaylistId: string,
): Promise<string | null> {
  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id: sourcePlaylistId,
      userId,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
      musicRetentionMode: MusicSourceRetentionMode.REMOVE_AFTER_PLAYED,
    },
    select: {
      id: true,
      spotifySnapshotId: true,
      cachedCandidates: true,
    },
  });

  if (!source?.spotifySnapshotId) return null;

  const cachedCandidates = decodeMusicSourceCache(source.cachedCandidates);
  if (!cachedCandidates || cachedCandidates.length === 0) return null;

  // Use the earliest full preview for this exact snapshot as the immutable
  // cleanup-grade baseline. A fallback can only exist after such a baseline,
  // so choosing the earliest matching PREVIEW prevents fallback-on-fallback
  // drift without adding provenance fields to the schema.
  const auditedSnapshot = await prisma.musicSourceCleanupRun.findFirst({
    where: {
      userId,
      sourcePlaylistId: source.id,
      status: MusicSourceCleanupStatus.PREVIEW,
      snapshotBefore: source.spotifySnapshotId,
      examinedCount: { gt: 0 },
    },
    orderBy: { startedAt: "asc" },
    select: {
      startedAt: true,
      examinedCount: true,
      removalOccurrenceCount: true,
      plannedUris: true,
    },
  });
  if (!auditedSnapshot) return null;

  const baselinePlannedUris = parseStringArray(auditedSnapshot.plannedUris);
  if (!baselinePlannedUris) return null;

  // Reaching this fallback means syncRecentlyPlayed already completed and the
  // later playlist-items read hit quota. We still require persisted policy
  // evidence before deriving anything from playback state.
  const policy = await prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
    select: { enabled: true, lastSyncAt: true },
  });
  if (!policy?.enabled || !policy.lastSyncAt) return null;

  const [playedStates, changedPlayedStates] = await Promise.all([
    prisma.trackListeningState.findMany({
      where: { userId },
      select: { spotifyTrackId: true },
    }),
    prisma.trackListeningState.findMany({
      where: {
        userId,
        updatedAt: { gt: auditedSnapshot.startedAt },
      },
      select: {
        spotifyTrackId: true,
        spotifyUri: true,
      },
    }),
  ]);

  const cacheEntries = cachedCandidates.flatMap((candidate) => {
    const spotifyTrackId = candidate.spotifyTrackId;
    if (
      typeof spotifyTrackId !== "string" ||
      !spotifyTrackId ||
      typeof candidate.uri !== "string" ||
      !candidate.uri
    ) {
      return [];
    }
    return [{ uri: candidate.uri, spotifyTrackId }];
  });

  const plan = buildAuditedCacheFallbackPlan({
    baseline: {
      examinedCount: auditedSnapshot.examinedCount,
      removalOccurrenceCount: auditedSnapshot.removalOccurrenceCount,
      plannedUris: baselinePlannedUris,
    },
    cachedCandidates: cacheEntries,
    playedTrackIds: new Set(playedStates.map((state) => state.spotifyTrackId)),
    changedPlayedTracks: changedPlayedStates,
  });
  if (!plan) return null;

  const run = await prisma.musicSourceCleanupRun.create({
    data: {
      userId,
      sourcePlaylistId: source.id,
      status: MusicSourceCleanupStatus.PREVIEW,
      snapshotBefore: source.spotifySnapshotId,
      planHash: plan.planHash,
      examinedCount: plan.examinedCount,
      removableTrackCount: plan.removableTrackCount,
      removalOccurrenceCount: plan.removalOccurrenceCount,
      keptCount: plan.keptCount,
      plannedUris: plan.removableUris as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  console.warn("MUSIC-02 preview used audited cache fallback after Spotify playlist quota", {
    sourcePlaylistId: source.id,
    previewId: run.id,
    snapshotId: source.spotifySnapshotId,
    examinedCount: plan.examinedCount,
    cachedCandidateCount: cacheEntries.length,
    removableTrackCount: plan.removableTrackCount,
  });

  return run.id;
}

async function getOrCreatePreview(userId: string, sourcePlaylistId: string) {
  const recent = await prisma.musicSourceCleanupRun.findFirst({
    where: {
      userId,
      sourcePlaylistId,
      status: MusicSourceCleanupStatus.PREVIEW,
      startedAt: {
        gte: new Date(Date.now() - RECENT_PREVIEW_REUSE_MS),
      },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (recent) return recent.id;

  const key = `${userId}:${sourcePlaylistId}`;
  const existing = inFlightPreviews.get(key);
  if (existing) return existing;

  const pending = createMusicSourceCleanupPreview(userId, sourcePlaylistId)
    .then((preview) => preview.previewId)
    .catch(async (error) => {
      // Never substitute a failed playback-history sync. Only a quota failure
      // from the later playlist-items read may use the audited source fallback.
      if (isPlaylistReadQuotaExceeded(error)) {
        const fallbackPreviewId = await createAuditedCacheFallbackPreview(
          userId,
          sourcePlaylistId,
        );
        if (fallbackPreviewId) return fallbackPreviewId;
      }
      throw error;
    })
    .finally(() => {
      inFlightPreviews.delete(key);
    });

  inFlightPreviews.set(key, pending);
  return pending;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const backoff = await getActiveSpotifyBackoff();
  if (backoff) {
    const payload = spotifyBackoffApiPayload(backoff);
    return NextResponse.json(
      {
        error: "spotify-backoff",
        ...payload,
      },
      {
        status: 429,
        headers: { "Retry-After": String(payload.retryAfterSecondsRemaining) },
      },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { sourcePlaylistId?: unknown }
    | null;
  const sourcePlaylistId =
    typeof body?.sourcePlaylistId === "string" ? body.sourcePlaylistId.trim() : "";

  if (!sourcePlaylistId) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  try {
    const previewId = await getOrCreatePreview(session.user.id, sourcePlaylistId);
    return NextResponse.json({ previewId });
  } catch (error) {
    if (error instanceof MusicSourceCleanupHistoryRequiredError) {
      return NextResponse.json({ error: "history" }, { status: 409 });
    }

    console.error("MUSIC-02 preview failed", error);
    return NextResponse.json({ error: "preview" }, { status: 500 });
  }
}