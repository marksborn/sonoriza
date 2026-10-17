import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import {
  parseCompleteReadingRequest, singleReadingEnabled,
} from "@/services/audiobooks/d9-completed-reading-contract";
import {
  completeManualReading, listCompletedManualReadings,
  readCompletedManualReading,
} from "@/services/audiobooks/d9-completed-reading-store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!singleReadingEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_READING_DISABLED" },
      { status: 404, headers });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" },
      { status: 401, headers });
  }
  const archiveId = new URL(request.url).searchParams.get("archiveId");
  try {
    if (archiveId !== null) {
      return NextResponse.json({
        archived: await readCompletedManualReading(session.user.id, archiveId),
      }, { headers });
    }
    return NextResponse.json({
      completed: await listCompletedManualReadings(session.user.id),
      remoteBookRemovalVerified: false,
      spotifyWrites: false,
    }, { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("AUDIOBOOK_READING_")) {
      return NextResponse.json({ code }, { status: 404, headers });
    }
    return NextResponse.json({ code: "AUDIOBOOK_READING_UNAVAILABLE" },
      { status: 503, headers });
  }
}

export async function POST(request: Request) {
  if (!singleReadingEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_READING_DISABLED" },
      { status: 404, headers });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" },
      { status: 401, headers });
  }
  if (!manualAudiobookOriginAllowed(
    request.headers.get("origin"), request.headers.get("host"),
  )) {
    return NextResponse.json({ code: "INVALID_ORIGIN" },
      { status: 403, headers });
  }
  let raw: unknown;
  try {
    const size = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(size) || size > 1024) {
      return NextResponse.json({ code: "INVALID_BODY" },
        { status: 413, headers });
    }
    raw = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY" },
      { status: 400, headers });
  }
  const parsed = parseCompleteReadingRequest(raw);
  if (!parsed.ok) {
    return NextResponse.json({ code: parsed.code },
      { status: 400, headers });
  }
  try {
    const result = await completeManualReading(session.user.id, parsed.value);
    return NextResponse.json(result, { status: 201, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code.startsWith("AUDIOBOOK_READING_")) {
      return NextResponse.json({ code }, { status: 409, headers });
    }
    return NextResponse.json({ code: "AUDIOBOOK_READING_UNAVAILABLE" },
      { status: 503, headers });
  }
}
