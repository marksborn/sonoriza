import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  audiobookMultiTargetEnabled, parseLibraryCommand,
} from "@/services/audiobooks/d12-library-contract";
import {
  mutateMultiPlaylistLibrary, readMultiPlaylistLibrary,
} from "@/services/audiobooks/d12-library-store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET() {
  if (!audiobookMultiTargetEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_LIBRARY_DISABLED" },
      { status: 404, headers });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers });
  }
  try {
    return NextResponse.json(await readMultiPlaylistLibrary(session.user.id), { headers });
  } catch {
    return NextResponse.json({ code: "AUDIOBOOK_LIBRARY_UNAVAILABLE" },
      { status: 503, headers });
  }
}

export async function POST(request: Request) {
  if (!audiobookMultiTargetEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_LIBRARY_DISABLED" },
      { status: 404, headers });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers });
  }
  if (!manualAudiobookOriginAllowed(
    request.headers.get("origin"), request.headers.get("host"),
  )) {
    return NextResponse.json({ code: "UNAUTHORIZED_OR_INVALID_ORIGIN" },
      { status: 403, headers });
  }
  let body: unknown;
  try {
    const size = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(size) || size > 4096) throw new Error("INVALID_SIZE");
    body = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY" },
      { status: 400, headers });
  }
  const command = parseLibraryCommand(body);
  if (!command.ok) {
    return NextResponse.json({ code: command.code }, { status: 400, headers });
  }
  try {
    const result = await mutateMultiPlaylistLibrary(session.user.id, command.value);
    return NextResponse.json({ ...result, spotifyWrites: false },
      { status: 201, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("AUDIOBOOK_LIBRARY_")) {
      return NextResponse.json({ code }, { status: 409, headers });
    }
    // Includes SQL uniqueness/constraint errors (race, old/foreign owner,
    // unexpected state). Never downgrade to a permissive success.
    return NextResponse.json({ code: "AUDIOBOOK_LIBRARY_OPERATION_FAILED" },
      { status: 503, headers });
  }
}
