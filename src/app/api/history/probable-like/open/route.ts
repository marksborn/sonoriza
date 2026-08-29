import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  ProbableLikeSpotifyIdentityNotResolvedError,
  resolveProbableLikeSpotifyIdentity,
} from "@/services/listening-history/probable-like-spotify-identity";
import { SpotifyBackoffActiveError } from "@/services/spotify/backoff";
import { isSpotifyApiError } from "@/services/spotify/errors";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  spotifyTrackId: z.string().min(1).max(128),
});

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/", request.url), 302);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    spotifyTrackId: url.searchParams.get("spotifyTrackId"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Faixa inválida." }, { status: 400 });
  }

  try {
    const identity = await resolveProbableLikeSpotifyIdentity({
      userId: session.user.id,
      historicalSpotifyTrackId: parsed.data.spotifyTrackId,
    });
    const response = NextResponse.redirect(identity.spotifyUrl, 302);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof ProbableLikeSpotifyIdentityNotResolvedError) {
      return NextResponse.json(
        {
          code: "SPOTIFY_TRACK_IDENTITY_NOT_RESOLVED",
          error: error.message,
        },
        { status: 409 },
      );
    }
    if (error instanceof SpotifyBackoffActiveError) {
      return NextResponse.json(
        {
          code: "SPOTIFY_BACKOFF_ACTIVE",
          error: "O Spotify pediu para aguardar antes de consultar o catálogo.",
          retryAfterSecondsRemaining: error.retryAfterSecondsRemaining,
          blockedUntil: error.blockedUntil.toISOString(),
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, error.retryAfterSecondsRemaining)),
          },
        },
      );
    }
    if (isSpotifyApiError(error)) {
      return NextResponse.json(
        {
          code: "SPOTIFY_CATALOG_LOOKUP_FAILED",
          error: "Não foi possível localizar a faixa atual no Spotify agora.",
        },
        { status: error.status === 429 ? 429 : 502 },
      );
    }
    throw error;
  }
}
