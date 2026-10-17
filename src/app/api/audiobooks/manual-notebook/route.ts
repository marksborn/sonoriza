import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  manualNotebookEnabled,
  parseSaveManualNotebookRequest,
} from "@/services/audiobooks/d7-manual-notebook-contract";
import {
  deleteUserDeclaredAudiobookNotebook,
  readUserDeclaredAudiobookNotebook,
  saveUserDeclaredAudiobookNotebook,
} from "@/services/audiobooks/d7-manual-notebook-store";

export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store" };
const TARGET_ID = /^[A-Za-z0-9_-]{4,80}$/;

function rejectDisabled() {
  return NextResponse.json({ code: "AUDIOBOOK_MANUAL_NOTEBOOK_DISABLED" },
    { status: 404, headers: HEADERS });
}
async function authorizedOwner(request: Request, mutation: boolean): Promise<string | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (mutation && !manualAudiobookOriginAllowed(
    request.headers.get("origin"), request.headers.get("host"),
  )) return null;
  return session.user.id;
}
async function bodyJson(request: Request): Promise<unknown> {
  const size = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(size) || size > 4096) throw new Error("INVALID_BODY");
  return request.json();
}
function safeFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code.startsWith("AUDIOBOOK_NOTEBOOK_")) {
    return NextResponse.json({ code }, { status: 409, headers: HEADERS });
  }
  if (typeof error === "object" && error !== null &&
      "code" in error && error.code === "P2002") {
    return NextResponse.json({ code: "AUDIOBOOK_NOTEBOOK_REVISION_CONFLICT" },
      { status: 409, headers: HEADERS });
  }
  return NextResponse.json({ code: "AUDIOBOOK_MANUAL_NOTEBOOK_UNAVAILABLE" },
    { status: 503, headers: HEADERS });
}

export async function GET(request: Request) {
  if (!manualNotebookEnabled(process.env)) return rejectDisabled();
  const ownerId = await authorizedOwner(request, false);
  if (!ownerId) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: HEADERS });
  const targetPlaylistId = new URL(request.url).searchParams.get("targetPlaylistId");
  if (!targetPlaylistId || !TARGET_ID.test(targetPlaylistId)) {
    return NextResponse.json({ code: "INVALID_TARGET_ID" }, { status: 400, headers: HEADERS });
  }
  try {
    const record = await readUserDeclaredAudiobookNotebook(ownerId, targetPlaylistId);
    return NextResponse.json(record, { headers: HEADERS });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function POST(request: Request) {
  if (!manualNotebookEnabled(process.env)) return rejectDisabled();
  const ownerId = await authorizedOwner(request, true);
  if (!ownerId) return NextResponse.json({ code: "UNAUTHORIZED_OR_INVALID_ORIGIN" },
    { status: 403, headers: HEADERS });
  let raw: unknown;
  try { raw = await bodyJson(request); } catch {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: HEADERS });
  }
  const parsed = parseSaveManualNotebookRequest(raw);
  if (!parsed.ok) return NextResponse.json({ code: parsed.code }, { status: 400, headers: HEADERS });
  try {
    const saved = await saveUserDeclaredAudiobookNotebook(ownerId, parsed.value);
    return NextResponse.json({ status: "SAVED_USER_DECLARED_NOTE_ONLY", notebook: saved },
      { status: 201, headers: HEADERS });
  } catch (error) {
    return safeFailure(error);
  }
}

export async function DELETE(request: Request) {
  if (!manualNotebookEnabled(process.env)) return rejectDisabled();
  const ownerId = await authorizedOwner(request, true);
  if (!ownerId) return NextResponse.json({ code: "UNAUTHORIZED_OR_INVALID_ORIGIN" },
    { status: 403, headers: HEADERS });
  let raw: unknown;
  try { raw = await bodyJson(request); } catch {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: HEADERS });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: HEADERS });
  }
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length !== 3 ||
      typeof body.targetPlaylistId !== "string" || !TARGET_ID.test(body.targetPlaylistId) ||
      typeof body.expectedRevision !== "number" ||
      !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1 ||
      body.confirmation !== "EXCLUIR_CADERNO_MANUAL_E_HISTORICO") {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: HEADERS });
  }
  try {
    await deleteUserDeclaredAudiobookNotebook(
      ownerId, body.targetPlaylistId, body.expectedRevision,
    );
    return NextResponse.json({ status: "MANUAL_NOTEBOOK_AND_HISTORY_DELETED" },
      { headers: HEADERS });
  } catch (error) {
    return safeFailure(error);
  }
}
