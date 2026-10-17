import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  audiobookChapterUpdateEnabled,
  parseManualChapterChangeRequest,
} from "@/services/audiobooks/manual-chapter-change-contract";
import { updateManualChapter } from "@/services/audiobooks/manual-chapter-change";

export const dynamic = "force-dynamic";

/** Gate C: local DB update only, no Spotify playlist or playback writes. */
export async function POST(request: Request) {
  if (!audiobookChapterUpdateEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_CHAPTER_UPDATE_DISABLED" }, { status: 404 });
  }
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ code: "INVALID_ORIGIN" }, { status: 403 });
  }
  let body: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4096)
      return NextResponse.json({ code: "INVALID_BODY" }, { status: 413 });
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });
  }
  const parsed = parseManualChapterChangeRequest(body, true);
  if (!parsed.ok) return NextResponse.json({ code: parsed.code }, { status: 400 });
  try {
    const result = await updateManualChapter(session.user.id, parsed.value);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_") ||
        code.startsWith("AUDIOBOOK_BIND_BLOCKED_")) {
      return NextResponse.json({
        code, error: "O vínculo mudou, foi bloqueado ou não permite esse capítulo. Atualize a tela e revise novamente.",
      }, { status: 409 });
    }
    return NextResponse.json({
      code: "AUDIOBOOK_CHAPTER_UPDATE_FAILED",
      error: "Não foi possível verificar o catálogo ou registrar a alteração local. O Spotify não foi alterado.",
    }, { status: 503 });
  }
}
