import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  ProbableLikeDismissalCandidateNotFoundError,
  dismissProbableLike,
} from "@/services/listening-history/probable-like-dismissal";

export const dynamic = "force-dynamic";

const dismissSchema = z.object({
  spotifyTrackId: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Invalid JSON is handled below.
  }

  const parsed = dismissSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Faixa inválida." }, { status: 400 });
  }

  try {
    const result = await dismissProbableLike({
      userId: session.user.id,
      spotifyTrackId: parsed.data.spotifyTrackId,
    });
    return NextResponse.json({
      result: {
        suppressUntil: result.suppressUntil.toISOString(),
        dismissCount: result.dismissCount,
      },
    });
  } catch (error) {
    if (error instanceof ProbableLikeDismissalCandidateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
