import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import { parseManualChapterChangeRequest } from "@/services/audiobooks/manual-chapter-change-contract";
import { previewManualChapterChange } from "@/services/audiobooks/manual-chapter-change";

export const dynamic = "force-dynamic";

/** Gate C read-only endpoint. Preview is never consent to commit. */
export async function POST(request: Request) {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") {
    return NextResponse.json({ code: "AUDIOBOOK_CHAPTER_UI_DISABLED" }, { status: 404 });
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
  const parsed = parseManualChapterChangeRequest(body, false);
  if (!parsed.ok) return NextResponse.json({ code: parsed.code }, { status: 400 });
  try {
    const preview = await previewManualChapterChange(session.user.id, parsed.value);
    return NextResponse.json(preview, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json({
      code: code.startsWith("AUDIOBOOK_CHAPTER_CHANGE_BLOCKED_") ? code :
        "AUDIOBOOK_CHAPTER_CHANGE_CATALOG_OR_STORAGE_UNAVAILABLE",
      error: "Não foi possível confirmar o capítulo ou a versão atual do vínculo. Nenhum dado foi alterado.",
    }, { status: 409 });
  }
}
