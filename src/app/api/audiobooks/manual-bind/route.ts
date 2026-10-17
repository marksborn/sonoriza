import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  audiobookBindEnabled,
  manualAudiobookOriginAllowed,
  parseManualAudiobookBindRequest,
} from "@/services/audiobooks/manual-bind-contract";
import { bindManualAudiobook } from "@/services/audiobooks/bind-manual-audiobook";

export const dynamic = "force-dynamic";

/**
 * AUDIOBOOK-02 Gate B.3 — explicit local association ONLY.
 *
 * Default: 404 until BOTH
 *   AUDIOBOOK02_BIND_MODE=ACTIVE
 *   AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE
 *
 * Never adds an item to Spotify or controls a chapter's playback.
 * No UI activates this endpoint and no production configuration is changed.
 */
export async function POST(request: Request) {
  if (!audiobookBindEnabled(process.env)) {
    return NextResponse.json({ error: "Recurso indisponível.", code: "AUDIOBOOK_BIND_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: "Origem não autorizada.", code: "INVALID_ORIGIN" }, { status: 403 });
  }

  let raw: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096) {
      return NextResponse.json({ error: "Requisição muito grande.", code: "INVALID_BODY" }, { status: 413 });
    }
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido.", code: "INVALID_BODY" }, { status: 400 });
  }
  const parsed = parseManualAudiobookBindRequest(raw);
  if (!parsed.ok) {
    return NextResponse.json({ error: "Dados do vínculo inválidos.", code: parsed.code }, { status: 400 });
  }

  try {
    const bound = await bindManualAudiobook(session.user.id, parsed.value);
    return NextResponse.json({
      status: "LINKED_LOCAL_ONLY",
      ...bound,
      message: "Livro vinculado localmente; a seleção e mudança de capítulo continuam manuais no Spotify.",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("AUDIOBOOK_BIND_BLOCKED_")) {
      return NextResponse.json({
        error: "Não foi possível confirmar um vínculo seguro. Nenhum item do Spotify foi alterado.",
        code,
      }, { status: 409 });
    }
    const duplicate = typeof error === "object" && error !== null &&
      "code" in error && error.code === "P2002";
    if (duplicate) {
      return NextResponse.json({
        error: "Este destino já possui um vínculo de audiolivro.",
        code: "AUDIOBOOK_BIND_BLOCKED_DUPLICATE",
      }, { status: 409 });
    }
    // Provider/account/DB errors are deliberately generic to clients.
    return NextResponse.json({
      error: "Não foi possível confirmar o catálogo Spotify ou gravar o vínculo. Nada foi alterado no Spotify.",
      code: "AUDIOBOOK_BIND_EVIDENCE_OR_STORAGE_UNAVAILABLE",
    }, { status: 503 });
  }
}
