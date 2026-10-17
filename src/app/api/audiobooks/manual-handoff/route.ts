import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  assessAudiobookManualHandoff,
  hasAudiobookManualHandoffShadow,
} from "@/services/audiobooks/manual-handoff-assessment";
import { SpotifyClient } from "@/services/spotify/client";

export const dynamic = "force-dynamic";

/**
 * Read-only Gate D.3: handoff of a CURRENT SIMULATED chapter-budget plan to
 * the user, not to the Spotify writer. No mutation endpoint is provided.
 *
 * Preview visibility is the only rollout flag. It is NOT authorization for
 * automatic writes; the DTO always sets authorizedForAutomaticWrite=false.
 */
export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW" ||
      process.env.AUDIOBOOK02_PLANNER_MODE !== "SHADOW") {
    return NextResponse.json({ code: "AUDIOBOOK_MANUAL_HANDOFF_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  }
  let raw: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096) {
      return NextResponse.json({ code: "INVALID_BODY" }, { status: 413 });
    }
    raw = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length !== 2 ||
      typeof body.targetPlaylistId !== "string" ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(body.targetPlaylistId) ||
      typeof body.expectedRevision !== "number" ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 0 || body.expectedRevision > 2147483647) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }

  try {
    const owner = session.user.id;
    const target = await prisma.targetPlaylist.findFirst({
      where: { id: body.targetPlaylistId, userId: owner },
      select: {
        id: true,
        userId: true,
        spotifyPlaylistId: true,
        durationMode: true,
        fixedDurationSeconds: true,
        updatePolicy: true,
        compositionMode: true,
        audiobookOverlay: {
          select: {
            userId: true,
            targetPlaylistId: true,
            spotifyPlaylistId: true,
            spotifyAudiobookId: true,
            selectedChapterId: true,
            chapterDurationMs: true,
            manualConsumedMs: true,
            selectionMode: true,
            revision: true,
          },
        },
      },
    });
    const overlay = target?.audiobookOverlay;
    if (!target || !overlay || overlay.revision !== body.expectedRevision ||
        !target.spotifyPlaylistId ||
        target.spotifyPlaylistId !== overlay.spotifyPlaylistId) {
      return NextResponse.json({ code: "AUDIOBOOK_MANUAL_HANDOFF_STALE_OVERLAY" }, { status: 409 });
    }
    const now = Date.now();
    const runs = await prisma.generationRun.findMany({
      where: {
        userId: owner,
        simulation: true,
        status: "SUCCESS",
        finishedAt: { gte: new Date(now - 60 * 60 * 1000) },
      },
      orderBy: { finishedAt: "desc" },
      take: 30,
      select: {
        id: true, userId: true, simulation: true, status: true,
        startedAt: true, finishedAt: true, summary: true,
      },
    });
    const run = runs.find(candidate =>
      hasAudiobookManualHandoffShadow(candidate.summary, target.id));
    if (!run) {
      return NextResponse.json({
        code: "AUDIOBOOK_MANUAL_HANDOFF_NO_RECENT_SHADOW",
        error: "Não há simulação SHADOW recente deste destino. Gere uma simulação sem escrita Spotify.",
      }, { status: 409 });
    }
    const client = await SpotifyClient.forUser(owner);
    const remote = await client.getTargetPlaylistState(overlay.spotifyPlaylistId);

    // Re-check ownership, exact target and all binding fields after the
    // provider read. A snapshot is diagnostic, never a writer CAS token.
    const fresh = await prisma.targetPlaylist.findFirst({
      where: {
        id: target.id,
        userId: owner,
        spotifyPlaylistId: target.spotifyPlaylistId,
        durationMode: target.durationMode,
        fixedDurationSeconds: target.fixedDurationSeconds,
        updatePolicy: target.updatePolicy,
        compositionMode: target.compositionMode,
      },
      select: {
        id: true,
        audiobookOverlay: {
          select: {
            userId: true,
            spotifyPlaylistId: true,
            spotifyAudiobookId: true,
            selectedChapterId: true,
            chapterDurationMs: true,
            manualConsumedMs: true,
            selectionMode: true,
            revision: true,
          },
        },
      },
    });
    if (!fresh?.audiobookOverlay ||
        fresh.audiobookOverlay.userId !== overlay.userId ||
        fresh.audiobookOverlay.spotifyPlaylistId !== overlay.spotifyPlaylistId ||
        fresh.audiobookOverlay.spotifyAudiobookId !== overlay.spotifyAudiobookId ||
        fresh.audiobookOverlay.selectedChapterId !== overlay.selectedChapterId ||
        fresh.audiobookOverlay.chapterDurationMs !== overlay.chapterDurationMs ||
        fresh.audiobookOverlay.manualConsumedMs !== overlay.manualConsumedMs ||
        fresh.audiobookOverlay.selectionMode !== overlay.selectionMode ||
        fresh.audiobookOverlay.revision !== overlay.revision) {
      return NextResponse.json({ code: "AUDIOBOOK_MANUAL_HANDOFF_CHANGED_DURING_READ" },
        { status: 409 });
    }
    const assessment = assessAudiobookManualHandoff({
      userId: owner,
      target,
      overlay,
      run,
      remote,
      nowMs: now,
    });
    return NextResponse.json(assessment, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      code: "AUDIOBOOK_MANUAL_HANDOFF_READ_FAILED",
      error: "Não foi possível verificar os dados atuais; nenhuma playlist foi alterada.",
    }, { status: 422 });
  }
}
