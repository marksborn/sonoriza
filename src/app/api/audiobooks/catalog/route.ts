import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import { readSpotifyAudiobookChapters } from "@/services/audiobooks/spotify-chapter-list";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") {
    return NextResponse.json({ error: "Indisponível.", code: "AUDIOBOOK_UI_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: "Origem não autorizada.", code: "INVALID_ORIGIN" }, { status: 403 });
  }

  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "JSON inválido.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).length !== 1 || !("spotifyAudiobookId" in raw) ||
    typeof raw.spotifyAudiobookId !== "string" ||
    !/^[A-Za-z0-9]{22}$/.test(raw.spotifyAudiobookId)) {
    return NextResponse.json({ error: "Informe o ID de um audiolivro Spotify.", code: "INVALID_AUDIOBOOK_ID" }, { status: 400 });
  }
  try {
    const catalogue = await readSpotifyAudiobookChapters(session.user.id, raw.spotifyAudiobookId);
    return NextResponse.json(catalogue, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({
      code: "AUDIOBOOK_CATALOG_UNAVAILABLE",
      error: "Não foi possível confirmar os capítulos no Spotify. A disponibilidade depende da conta e do país. Nenhum dado foi vinculado.",
    }, { status: 422 });
  }
}
