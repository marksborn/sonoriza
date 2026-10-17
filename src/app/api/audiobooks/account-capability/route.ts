import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  assessSpotifyAudiobookAccountCapability,
  type AudiobookCapabilityEvidence,
} from "@/services/audiobooks/d5-account-capability";
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
  const evidence: AudiobookCapabilityEvidence = {
    spotifyConnected: false,
    profileScopeGranted: false,
    profileRead: "NOT_ATTEMPTED",
    accountCountry: null,
    catalogRead: "NOT_ATTEMPTED",
    checkedAudiobookId: null,
    readableChapterCount: null,
    playableChapterCount: null,
  };
  let connected = false;
  let privateScope = false;
  let profileRead: AudiobookCapabilityEvidence["profileRead"] = "NOT_ATTEMPTED";
  let accountCountry: unknown = null;
  let catalogRead: AudiobookCapabilityEvidence["catalogRead"] = "NOT_ATTEMPTED";
  let checkedAudiobookId: string | null = null;
  let readableChapterCount: number | null = null;
  let playableChapterCount: number | null = null;
  try {
    const linked = await prisma.account.findFirst({
      where: { userId: ownerId, provider: "spotify" },
      select: { id: true, scope: true },
    });
    connected = Boolean(linked);
    privateScope = Boolean(linked?.scope?.split(/\s+/).includes("user-read-private"));
    if (connected && privateScope) {
      try {
        const token = await getSpotifyAccessToken(ownerId);
        const profile = await spotifyRequestAttempt<unknown>({
          accessToken: token,
          path: "/me",
          method: "GET",
          operation: "current-user",
        });
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
          throw new Error("AUDIOBOOK_PROFILE_INVALID");
        }
        const data = profile as Record<string, unknown>;
        profileRead = "SUCCESS";
        accountCountry = data.country;
      } catch {
        profileRead = "ERROR";
      }

      const country = typeof accountCountry === "string" ? accountCountry : null;
      const supportedCountry = [
        "US", "GB", "CA", "IE", "NZ", "AU",
      ].includes(country ?? "");
      if (profileRead === "SUCCESS" && supportedCountry &&
          typeof body.spotifyAudiobookId === "string") {
        try {
          const catalogue = await readSpotifyAudiobookChapters(
            ownerId, body.spotifyAudiobookId,
          );
          if (catalogue.truncated) {
            throw new Error("AUDIOBOOK_CATALOG_INCOMPLETE");
          }
          catalogRead = "SUCCESS";
          checkedAudiobookId = catalogue.audiobookId;
          readableChapterCount = catalogue.chapters.length;
          playableChapterCount = catalogue.chapters.filter(ch => ch.playable).length;
        } catch {
          catalogRead = "ERROR";
        }
      }
    }
  } catch {
    // Database or grant read unknown: fail closed and do not guess a market.
    return NextResponse.json({
      code: "AUDIOBOOK_ACCOUNT_DIAGNOSTIC_UNAVAILABLE",
      error: "Não foi possível consultar com segurança os dados desta conta.",
    }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  const decision = assessSpotifyAudiobookAccountCapability({
    ...evidence,
    spotifyConnected: connected,
    profileScopeGranted: privateScope,
    profileRead,
    accountCountry,
    catalogRead,
    checkedAudiobookId,
    readableChapterCount,
    playableChapterCount,
  });
  return NextResponse.json(decision, { headers: { "Cache-Control": "no-store" } });
}
