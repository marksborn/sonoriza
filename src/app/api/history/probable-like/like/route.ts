import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  ProbableLikeCandidateNotFoundError,
  confirmProbableLike,
} from "@/services/listening-history/probable-like-action";
import { isSpotifyApiError } from "@/services/spotify/errors";
import { SpotifyLibraryModifyScopeRequiredError } from "@/services/spotify/library";

export const dynamic = "force-dynamic";

const likeSchema = z.object({
  spotifyTrackId: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON is handled below.
  }

  const parsed = likeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Faixa inválida." }, { status: 400 });
  }

  try {
    const result = await confirmProbableLike({
      userId: session.user.id,
      spotifyTrackId: parsed.data.spotifyTrackId,
    });
    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof ProbableLikeCandidateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof SpotifyLibraryModifyScopeRequiredError) {
      return NextResponse.json(
        {
          code: "SPOTIFY_RECONNECT_REQUIRED",
          error: error.message,
          reconnectPath: "/dashboard/configuracao/revisao",
        },
        { status: 428 },
      );
    }
    if (isSpotifyApiError(error)) {
      return NextResponse.json(
        {
          code: "SPOTIFY_LIBRARY_WRITE_FAILED",
          error:
            error.status === 429
              ? "O Spotify pediu para aguardar antes de tentar novamente."
              : "O Spotify não confirmou a inclusão em Músicas Curtidas. Tente novamente.",
        },
        { status: error.status === 429 ? 429 : 502 },
      );
    }
    throw error;
  }
}
