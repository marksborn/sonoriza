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
  buildMusicSourceCleanupPlan,
  createMusicSourceCleanupPreview,
  MusicSourceCleanupHistoryRequiredError,
} from "@/services/spotify/source-cleanup";
import { decodeMusicSourceCache } from "@/services/spotify/source-cache";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RECENT_PREVIEW_REUSE_MS = 10 * 60 * 1000;
const inFlightPreviews = new Map<string, Promise<string>>();

function isQuotaExceeded(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "kind" in error &&
      (error as { kind?: unknown }).kind === "QUOTA_EXCEEDED",
  );
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

  // A quota fallback is allowed only when this exact cached snapshot has already
  // been fully read and persisted by a previous MUSIC-02 preview. That keeps the
  // displayed examined count anchored in audited evidence instead of guessing
  // from the candidate cache (which intentionally excludes some non-candidates).
  const auditedSnapshot = await prisma.musicSourceCleanupRun.findFirst({
    where: {
      userId,
      sourcePlaylistId: source.id,
      snapshotBefore: source.spotifySnapshotId,
      examinedCount: { gt: 0 },
    },
    orderBy: { startedAt: "desc" },
    select: { examinedCount: true },
  });
  if (!auditedSnapshot) return null;

  const policy = await prisma.musicPlaybackPolicy.findUnique({
    where: { userId },
    select: { enabled: true, lastSyncAt: true },
  });
  if (!policy?.enabled || !policy.lastSyncAt) return null;

  const playedStates = await prisma.trackListeningState.findMany({
    where: { userId },
    select: { spotifyTrackId: true },
  });

  const occurrences = cachedCandidates.flatMap((candidate) => {
    const spotifyTrackId = candidate.spotifyTrackId;
    if (typeof spotifyTrackId !== "string" || !spotifyTrackId) return [];
    return [
      {
        uri: candidate.uri,
        aliases: [spotifyTrackId],
        isTrack: true,
        isLocal: false,
      },
    ];
  });

  const cachedPlan = buildMusicSourceCleanupPlan(
    occurrences,
    new Set(playedStates.map((state) => state.spotifyTrackId)),
  );
  const examinedCount = Math.max(
    auditedSnapshot.examinedCount,
    cachedPlan.examinedCount,
  );
  const keptCount = Math.max(
    0,
    examinedCount - cachedPlan.removalOccurrenceCount,
  );

  const run = await prisma.musicSourceCleanupRun.create({
    data: {
      userId,
      sourcePlaylistId: source.id,
      status: MusicSourceCleanupStatus.PREVIEW,
      snapshotBefore: source.spotifySnapshotId,
      planHash: cachedPlan.planHash,
      examinedCount,
      removableTrackCount: cachedPlan.removableTrackCount,
      removalOccurrenceCount: cachedPlan.removalOccurrenceCount,
      keptCount,
      plannedUris: cachedPlan.removableUris as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  console.warn("MUSIC-02 preview used audited cache fallback after Spotify quota", {
    sourcePlaylistId: source.id,
    previewId: run.id,
    snapshotId: source.spotifySnapshotId,
    examinedCount,
    cachedCandidateCount: occurrences.length,
    removableTrackCount: cachedPlan.removableTrackCount,
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
      if (isQuotaExceeded(error)) {
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
