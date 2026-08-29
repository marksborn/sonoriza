import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  ProbableLikePilotCandidateNotFoundError,
  getProbableLikePilotSummary,
  recordProbableLikePilotFeedback,
} from "@/services/listening-history/probable-like-pilot";

export const dynamic = "force-dynamic";

const feedbackSchema = z.object({
  spotifyTrackId: z.string().min(1).max(128),
  verdict: z.enum(["LIKED", "INDIFFERENT", "DISLIKED"]),
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
    // Invalid JSON is handled by the schema below.
  }

  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Avaliação inválida." }, { status: 400 });
  }

  try {
    const feedback = await recordProbableLikePilotFeedback({
      userId: session.user.id,
      spotifyTrackId: parsed.data.spotifyTrackId,
      verdict: parsed.data.verdict,
    });
    const summary = await getProbableLikePilotSummary(session.user.id);
    return NextResponse.json({ feedback, summary });
  } catch (error) {
    if (error instanceof ProbableLikePilotCandidateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
