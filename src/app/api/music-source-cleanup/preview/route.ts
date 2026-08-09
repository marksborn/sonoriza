import { MusicSourceCleanupStatus } from "@prisma/client";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createMusicSourceCleanupPreview,
  MusicSourceCleanupHistoryRequiredError,
} from "@/services/spotify/source-cleanup";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RECENT_PREVIEW_REUSE_MS = 10 * 60 * 1000;
const inFlightPreviews = new Map<string, Promise<string>>();

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
