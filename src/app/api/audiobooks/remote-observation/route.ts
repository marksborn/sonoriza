import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import { analyzeOpaqueAudiobookPlaylist } from "@/services/audiobooks/opaque-playlist-reconciliation";
import { SpotifyClient } from "@/services/spotify/client";

export const dynamic = "force-dynamic";

/**
 * Read-only, owner-scoped Spotify snapshot report.
 * It is never a proof of which audiobook is in item=null and never returns
 * a token permitting append/replace/remove.
 */
export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") {
    return NextResponse.json({ code: "AUDIOBOOK_RECONCILIATION_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  }
  let raw: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096)
      return NextResponse.json({ code: "INVALID_BODY" }, { status: 413 });
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
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }
  try {
    const filter = {
      userId: session.user.id,
      targetPlaylistId: body.targetPlaylistId,
      revision: body.expectedRevision,
    };
    const overlay = await prisma.targetAudiobookOverlay.findFirst({
      where: filter,
      select: {
        id: true,
        spotifyPlaylistId: true,
        target: { select: { spotifyPlaylistId: true } },
      },
    });
    if (!overlay || overlay.target.spotifyPlaylistId !== overlay.spotifyPlaylistId) {
      return NextResponse.json({ code: "AUDIOBOOK_REMOTE_LINK_CHANGED" }, { status: 409 });
    }

    const client = await SpotifyClient.forUser(session.user.id);
    // getTargetPlaylistState reads both snapshot ids and all item pages;
    // returns an error if the playlist changes during the read.
    const state = await client.getTargetPlaylistState(overlay.spotifyPlaylistId);
    const observation = analyzeOpaqueAudiobookPlaylist(state);

    const fresh = await prisma.targetAudiobookOverlay.findFirst({
      where: { ...filter, id: overlay.id, spotifyPlaylistId: overlay.spotifyPlaylistId },
      select: { id: true, target: { select: { spotifyPlaylistId: true } } },
    });
    if (!fresh || fresh.target.spotifyPlaylistId !== overlay.spotifyPlaylistId) {
      return NextResponse.json({ code: "AUDIOBOOK_REMOTE_LINK_CHANGED" }, { status: 409 });
    }
    return NextResponse.json(observation, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      code: "AUDIOBOOK_REMOTE_UNAVAILABLE",
      error: "O Spotify não permitiu confirmar um snapshot estável. Nenhuma playlist foi modificada.",
    }, { status: 422 });
  }
}
