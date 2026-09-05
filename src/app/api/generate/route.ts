import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { generatePlaylists } from "@/jobs/generate-playlists";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import { parseMusic06RunExplainability } from "@/services/music-preference/lastfm-planner-explainability";
import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";
import { dispatchGenerationRunNotificationSafely } from "@/services/notifications";
import {
  getActiveSpotifyBackoff,
  spotifyBackoffApiPayload,
} from "@/services/spotify/backoff";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [assessment, spotifyBackoff, recentRealRuns] = await Promise.all([
    assessConfiguration(session.user.id),
    getActiveSpotifyBackoff(),
    prisma.generationRun.findMany({
      where: { userId: session.user.id, simulation: false },
      orderBy: { startedAt: "desc" },
      take: 10,
      select: {
        id: true,
        startedAt: true,
        status: true,
        summary: true,
      },
    }),
  ]);
  const gate = await getFirstRunGate(session.user.id, assessment);

  return NextResponse.json({
    ...gate,
    issues: assessment.issues,
    reviewUrl: "/dashboard/configuracao/revisao",
    spotifyBackoff: spotifyBackoff
      ? spotifyBackoffApiPayload(spotifyBackoff)
      : null,
    music06Explainability: latestMusic06Explainability(recentRealRuns),
  });
}

/**
 * Manual / simulation trigger for the signed-in user.
 *
 *   POST /api/generate
 *     → applies every enabled destination, subject to CONFIG-04
 *
 *   POST /api/generate { "simulate": true }
 *     → plans every enabled destination without touching Spotify
 *
 *   POST /api/generate { "targetPlaylistIds": ["..."] }
 *     → applies only those enabled destinations owned by the signed-in user
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const spotifyBackoff = await getActiveSpotifyBackoff();
  if (spotifyBackoff) {
    const payload = spotifyBackoffApiPayload(spotifyBackoff);
    return NextResponse.json(
      {
        error: `O Spotify pediu para aguardar até ${spotifyBackoff.blockedUntil.toISOString()} antes de uma nova tentativa.`,
        ...payload,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(payload.retryAfterSecondsRemaining),
        },
      },
    );
  }

  let simulate = false;
  let targetPlaylistIds: string[] | undefined;
  try {
    const body = (await request.json()) as {
      simulate?: unknown;
      targetPlaylistIds?: unknown;
    };
    simulate = Boolean(body?.simulate);

    if (body?.targetPlaylistIds !== undefined) {
      if (
        !Array.isArray(body.targetPlaylistIds) ||
        body.targetPlaylistIds.some(
          (value) => typeof value !== "string" || !value.trim(),
        )
      ) {
        return NextResponse.json(
          {
            error: "Informe uma lista válida de destinos para a geração individual.",
            code: "INVALID_TARGET_SCOPE",
          },
          { status: 400 },
        );
      }

      targetPlaylistIds = [
        ...new Set(body.targetPlaylistIds.map((value) => value.trim())),
      ];
      if (targetPlaylistIds.length === 0) {
        return NextResponse.json(
          {
            error: "Selecione pelo menos um destino para a geração individual.",
            code: "EMPTY_TARGET_SCOPE",
          },
          { status: 400 },
        );
      }
    }
  } catch {
    // No / invalid body → preserve the existing default of a real general run.
  }

  if (targetPlaylistIds) {
    const ownedTargets = await prisma.targetPlaylist.findMany({
      where: {
        userId: session.user.id,
        enabled: true,
        id: { in: targetPlaylistIds },
      },
      select: { id: true },
    });

    if (ownedTargets.length !== targetPlaylistIds.length) {
      return NextResponse.json(
        {
          error: "Um ou mais destinos não existem, estão desabilitados ou não pertencem à sua conta.",
          code: "TARGET_NOT_AVAILABLE",
        },
        { status: 404 },
      );
    }
  }

  const assessment = await assessConfiguration(session.user.id);
  if (assessment.issues.length > 0) {
    return NextResponse.json(
      {
        error: "Revise as pendências da configuração antes de executar.",
        code: "CONFIGURATION_INCOMPLETE",
        issues: assessment.issues,
        reviewUrl: "/dashboard/configuracao/revisao",
      },
      { status: 409 },
    );
  }

  if (!simulate) {
    const gate = await getFirstRunGate(session.user.id, assessment);
    if (!gate.realRunAllowed) {
      return NextResponse.json(
        {
          error: gate.reason ?? "Faça uma simulação antes da primeira geração real.",
          code: "FIRST_RUN_SIMULATION_REQUIRED",
          reviewUrl: "/dashboard/configuracao/revisao",
        },
        { status: 409 },
      );
    }
  }

  const musicOrderSimulationEvidence = simulate
    ? undefined
    : await findReusableSimulationMusicOrderEvidence(
        session.user.id,
        assessment.fingerprint,
      );

  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
    musicOrderSimulationEvidence,
    targetPlaylistIds,
  });

  const run = await prisma.generationRun.findFirst({
    where: {
      id: result.runId,
      userId: session.user.id,
      simulation: simulate,
    },
    select: {
      id: true,
      startedAt: true,
      status: true,
      summary: true,
    },
  });

  const existingSummary =
    run?.summary && typeof run.summary === "object" && !Array.isArray(run.summary)
      ? (run.summary as Record<string, unknown>)
      : {};

  await prisma.generationRun.updateMany({
    where: {
      id: result.runId,
      userId: session.user.id,
      simulation: simulate,
    },
    data: {
      summary: {
        ...existingSummary,
        configurationFingerprint: assessment.fingerprint,
      } as Prisma.InputJsonValue,
    },
  });

  if (!simulate) {
    await dispatchGenerationRunNotificationSafely(result.runId);
  }

  return NextResponse.json({
    ...result,
    music06Explainability:
      !simulate && run ? music06ExplainabilityPayload(run) : null,
  });
}

type ExplainableRun = Readonly<{
  id: string;
  startedAt: Date;
  status: string;
  summary: unknown;
}>;

function latestMusic06Explainability(runs: readonly ExplainableRun[]) {
  for (const run of runs) {
    const payload = music06ExplainabilityPayload(run);
    if (payload) return payload;
  }
  return null;
}

function music06ExplainabilityPayload(run: ExplainableRun) {
  const explainability = parseMusic06RunExplainability(run.summary);
  if (!explainability) return null;
  return {
    runId: run.id,
    startedAt: run.startedAt.toISOString(),
    runStatus: run.status,
    ...explainability,
  };
}
