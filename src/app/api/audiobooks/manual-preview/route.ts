import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  AUDIOBOOK_BIND_CONFIRMATION,
  manualAudiobookOriginAllowed,
  parseManualAudiobookBindRequest,
} from "@/services/audiobooks/manual-bind-contract";
import { previewManualAudiobook } from "@/services/audiobooks/preview-manual-audiobook";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") {
    return NextResponse.json({ error: "Indisponível.", code: "AUDIOBOOK_UI_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: "Origem não autorizada.", code: "INVALID_ORIGIN" }, { status: 403 });
  }
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ error: "JSON inválido.", code: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof raw !== "object" || !raw || Array.isArray(raw)) {
    return NextResponse.json({ error: "Dados inválidos.", code: "INVALID_BODY" }, { status: 400 });
  }
  // The preview does not require consent because it only performs GET operations.
  // The confirmation is created internally for strict structural validation.
  const input = parseManualAudiobookBindRequest({
    ...raw,
    confirmation: AUDIOBOOK_BIND_CONFIRMATION,
  });
  if (!input.ok) return NextResponse.json({ error: "Dados inválidos.", code: input.code }, { status: 400 });
  try {
    return NextResponse.json(await previewManualAudiobook(session.user.id, input.value), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({
      error: "Não foi possível validar a duração e o vínculo. Confira o capítulo e a disponibilidade no Spotify.",
      code: error instanceof Error && error.message.startsWith("AUDIOBOOK_PREVIEW_")
        ? error.message : "AUDIOBOOK_PREVIEW_PROVIDER_OR_STORAGE_UNAVAILABLE",
    }, { status: 422 });
  }
}
