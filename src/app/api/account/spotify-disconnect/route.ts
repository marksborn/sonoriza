import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  buildSpotifyDisconnectExecutionUiState,
  buildSpotifyDisconnectPreparationUiState,
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
  SPOTIFY_DISCONNECT_ERROR_CODES,
  SpotifyDisconnectError,
} from "@/services/data-policy";

export const dynamic = "force-dynamic";

const executeSchema = z.object({
  contractVersion: z.number().int().positive(),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  confirmation: z.string().min(1).max(128),
});

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const preparation = await prepareSpotifyDisconnect(session.user.id);
  return noStoreJson(buildSpotifyDisconnectPreparationUiState(preparation));
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON is rejected by the schema below.
  }

  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return noStoreJson(
      { error: "Confirmação de desconexão inválida." },
      { status: 400 },
    );
  }

  try {
    const result = await executeSpotifyDisconnect({
      userId: session.user.id,
      contractVersion: parsed.data.contractVersion,
      expectedFingerprint: parsed.data.expectedFingerprint,
      confirmation: parsed.data.confirmation,
    });

    return noStoreJson(buildSpotifyDisconnectExecutionUiState(result));
  } catch (error) {
    if (error instanceof SpotifyDisconnectError) {
      return noStoreJson(
        { error: error.message, code: error.code },
        { status: statusForDisconnectError(error) },
      );
    }

    console.error("[spotify-disconnect] unexpected execution failure", error);
    return noStoreJson(
      { error: "Falha interna ao desconectar o Spotify." },
      { status: 500 },
    );
  }
}

function statusForDisconnectError(error: SpotifyDisconnectError): number {
  switch (error.code) {
    case SPOTIFY_DISCONNECT_ERROR_CODES.USER_NOT_FOUND:
      return 404;
    case SPOTIFY_DISCONNECT_ERROR_CODES.CONTRACT_VERSION_MISMATCH:
    case SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED:
      return 409;
    case SPOTIFY_DISCONNECT_ERROR_CODES.CONFIRMATION_REQUIRED:
      return 400;
    case SPOTIFY_DISCONNECT_ERROR_CODES.POSTCHECK_FAILED:
      return 500;
  }
}

function noStoreJson(
  body: unknown,
  init: { status?: number } = {},
): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { "Cache-Control": "no-store" },
  });
}
