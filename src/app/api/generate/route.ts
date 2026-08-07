import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { generatePlaylists } from "@/jobs/generate-playlists";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const assessment = await assessConfiguration(session.user.id);
  const gate = await getFirstRunGate(session.user.id, assessment);

  return NextResponse.json({
    ...gate,
    issues: assessment.issues,
    reviewUrl: "/dashboard/configuracao/revisao",
  });
}

/**
 * Manual / simulation trigger for the signed-in user.
 *
 *   POST /api/generate            → applies the playlists, subject to CONFIG-04
 *   POST /api/generate  { "simulate": true }  → plans without touching Spotify
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let simulate = false;
  try {
    const body = (await request.json()) as { simulate?: boolean };
    simulate = Boolean(body?.simulate);
  } catch {
    // No / invalid body → default to a real run.
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

  const result = await generatePlaylists({
    userId: session.user.id,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
  });

  const run = await prisma.generationRun.findFirst({
    where: {
      id: result.runId,
      userId: session.user.id,
      simulation: simulate,
    },
    select: { summary: true },
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

  return NextResponse.json(result);
}
