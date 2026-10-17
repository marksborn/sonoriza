/** AUDIOBOOK-02 D.8: read-only, separately flagged advisory route. */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { manualAudiobookOriginAllowed } from "@/services/audiobooks/manual-bind-contract";
import { manualNotebookEnabled } from "@/services/audiobooks/d7-manual-notebook-contract";
import {
  projectUserDeclaredAudiobookAdvisory,
} from "@/services/audiobooks/d8-manual-advisory-shadow";

export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };

export function manualAdvisoryEnabled(env: Record<string, string | undefined>) {
  return manualNotebookEnabled(env) &&
    env.AUDIOBOOK02_MANUAL_SHADOW_MODE === "PREVIEW";
}

function parsePayload(raw: unknown): {
  targetPlaylistId: string; expectedRevision: number;
  sampleMusicDurationsMs: number[]; samplePodcastDurationsMs: number[];
} | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const allowed = [
    "targetPlaylistId", "expectedRevision",
    "sampleMusicDurationsMs", "samplePodcastDurationsMs",
  ];
  if (Object.keys(obj).length !== allowed.length ||
      Object.keys(obj).some(key => !allowed.includes(key)) ||
      typeof obj.targetPlaylistId !== "string" ||
      !/^[A-Za-z0-9_-]{4,80}$/.test(obj.targetPlaylistId) ||
      typeof obj.expectedRevision !== "number" ||
      !Number.isSafeInteger(obj.expectedRevision) ||
      obj.expectedRevision < 1 || obj.expectedRevision > 2147483647 ||
      !Array.isArray(obj.sampleMusicDurationsMs) ||
      !Array.isArray(obj.samplePodcastDurationsMs) ||
      ![...obj.sampleMusicDurationsMs, ...obj.samplePodcastDurationsMs].every(
        v => typeof v === "number" && Number.isSafeInteger(v) &&
          v > 0 && v <= 86_400_000,
      ) ||
      obj.sampleMusicDurationsMs.length > 12 ||
      obj.samplePodcastDurationsMs.length > 12 ||
      obj.sampleMusicDurationsMs.length + obj.samplePodcastDurationsMs.length === 0) {
    return null;
  }
  return {
    targetPlaylistId: obj.targetPlaylistId,
    expectedRevision: obj.expectedRevision,
    sampleMusicDurationsMs: obj.sampleMusicDurationsMs as number[],
    samplePodcastDurationsMs: obj.samplePodcastDurationsMs as number[],
  };
}

export async function POST(request: Request) {
  if (!manualAdvisoryEnabled(process.env)) {
    return NextResponse.json({ code: "AUDIOBOOK_MANUAL_ADVISORY_DISABLED" },
      { status: 404, headers: noStore });
  }
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: noStore });
  }
  if (!manualAudiobookOriginAllowed(request.headers.get("origin"),
    request.headers.get("host"))) {
    return NextResponse.json({ code: "INVALID_ORIGIN" }, { status: 403, headers: noStore });
  }
  let raw: unknown;
  try {
    const headerSize = Number(request.headers.get("content-length") ?? 0);
    if (!Number.isFinite(headerSize) || headerSize > 4096) {
      return NextResponse.json({ code: "INVALID_BODY" }, { status: 413, headers: noStore });
    }
    raw = await request.json();
  } catch {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: noStore });
  }
  const payload = parsePayload(raw);
  if (!payload) {
    return NextResponse.json({ code: "INVALID_BODY" }, { status: 400, headers: noStore });
  }
  try {
    // Single owner-scoped snapshot: no file/user/provider writes, and no real
    // GenerationRun or API client instance is ever created.
    const notebook = await prisma.targetAudiobookManualNotebook.findFirst({
      where: {
        targetPlaylistId: payload.targetPlaylistId,
        userId: session.user.id,
      },
      include: {
        target: {
          select: {
            id: true, userId: true, spotifyPlaylistId: true,
            durationMode: true, fixedDurationSeconds: true,
            compositionMode: true, updatePolicy: true,
            podcastPercent: true,
            audiobookOverlay: { select: { id: true } },
          },
        },
      },
    });
    if (!notebook) {
      return NextResponse.json({ status: "ABSTAIN", reason: "NOTEBOOK_NOT_FOUND_OR_FOREIGN",
        plannerInfluence: false, spotifyWrites: false, approvalEligible: false },
      { status: 404, headers: noStore });
    }
    const result = projectUserDeclaredAudiobookAdvisory({
      ownerId: session.user.id,
      expectedRevision: payload.expectedRevision,
      notebook,
      target: {
        ...notebook.target,
        hasVerifiedOverlay: notebook.target.audiobookOverlay !== null,
      },
      sampleMusicDurationsMs: payload.sampleMusicDurationsMs,
      samplePodcastDurationsMs: payload.samplePodcastDurationsMs,
    });
    return NextResponse.json(result, {
      status: result.status === "ABSTAIN" ? 409 : 200,
      headers: noStore,
    });
  } catch {
    return NextResponse.json({ code: "AUDIOBOOK_MANUAL_ADVISORY_UNAVAILABLE" },
      { status: 503, headers: noStore });
  }
}
