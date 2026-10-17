import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  probeSpotifyAudiobookAccountCapability,
} from "@/services/audiobooks/d5-account-capability-probe";
import { getSpotifyAccessToken } from "@/services/spotify/token";
import { spotifyRequestAttempt } from "@/services/spotify/request";
import { readSpotifyAudiobookChapters } from "@/services/audiobooks/spotify-chapter-list";

export const dynamic = "force-dynamic";

/**
 * AUDIOBOOK-02 Gate D.5. On-demand, no-store read-only diagnostic.
 * The connected account owns the identity and market evidence.
 * No OAuth scope changes; never claim writes can preserve an opaque book.
 */
export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") {
    return NextResponse.json({ code: "AUDIOBOOK_ACCOUNT_CAPABILITY_DISABLED" },
      { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  }

  let raw: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 1024) {
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
  if (Object.keys(body).some(key => key !== "spotifyAudiobookId") ||
      (body.spotifyAudiobookId !== undefined &&
        (typeof body.spotifyAudiobookId !== "string" ||
         !/^[A-Za-z0-9]{22}$/.test(body.spotifyAudiobookId)))) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }

  const ownerId = session.user.id;
  try {
    const linked = await prisma.account.findFirst({
      where: { userId: ownerId, provider: "spotify" },
      select: { id: true, scope: true },
    });
    const decision = await probeSpotifyAudiobookAccountCapability({
      spotifyConnected: Boolean(linked),
      profileScopeGranted:
        Boolean(linked?.scope?.split(/\\s+/).includes("user-read-private")),
      requestedAudiobookId: typeof body.spotifyAudiobookId === "string"
        ? body.spotifyAudiobookId
        : null,
      readProfile: async () => {
        const token = await getSpotifyAccessToken(ownerId);
        return spotifyRequestAttempt<unknown>({
          accessToken: token,
          path: "/me",
          method: "GET",
          operation: "current-user",
        });
      },
      readCatalog: id => readSpotifyAudiobookChapters(ownerId, id),
    });
    return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Database identity lookup failure is distinct from provider denial.
    return NextResponse.json({
      code: "AUDIOBOOK_ACCOUNT_DIAGNOSTIC_UNAVAILABLE",
      error: "Não foi possível consultar com segurança os dados desta conta.",
    }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
}
