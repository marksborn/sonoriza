import type { ProbableLikePilotVerdict } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getProbableLikeShadow } from "./probable-like";

export type ProbableLikePilotFeedbackView = {
  spotifyTrackId: string;
  verdict: ProbableLikePilotVerdict;
  evaluatedAt: Date;
};

export type ProbableLikePilotSummary = {
  evaluatedCount: number;
  likedCount: number;
  indifferentCount: number;
  dislikedCount: number;
  precisionPercent: number;
  feedbackByTrackId: Record<string, ProbableLikePilotFeedbackView>;
};

/**
 * HISTORY-04 Gate 4 — pilot-only manual validation.
 *
 * Verdicts deliberately live outside LikedTrackPreference and
 * MusicPreferenceSignal. They measure ranking quality only and have no planner,
 * discovery or provider side effect.
 */
export async function getProbableLikePilotSummary(
  userId: string,
): Promise<ProbableLikePilotSummary> {
  const rows = await prisma.probableLikePilotFeedback.findMany({
    where: { userId },
    orderBy: [{ evaluatedAt: "desc" }, { id: "desc" }],
    select: {
      spotifyTrackId: true,
      verdict: true,
      evaluatedAt: true,
    },
  });

  let likedCount = 0;
  let indifferentCount = 0;
  let dislikedCount = 0;
  const feedbackByTrackId: Record<string, ProbableLikePilotFeedbackView> = {};

  for (const row of rows) {
    if (row.verdict === "LIKED") likedCount += 1;
    if (row.verdict === "INDIFFERENT") indifferentCount += 1;
    if (row.verdict === "DISLIKED") dislikedCount += 1;
    feedbackByTrackId[row.spotifyTrackId] = row;
  }

  const evaluatedCount = rows.length;
  const precisionPercent =
    evaluatedCount > 0
      ? Math.round((likedCount / evaluatedCount) * 1000) / 10
      : 0;

  return {
    evaluatedCount,
    likedCount,
    indifferentCount,
    dislikedCount,
    precisionPercent,
    feedbackByTrackId,
  };
}

export async function recordProbableLikePilotFeedback(input: {
  userId: string;
  spotifyTrackId: string;
  verdict: ProbableLikePilotVerdict;
}) {
  const ranking = await getProbableLikeShadow(input.userId, { limit: 25 });
  const candidate = ranking.candidates.find(
    (item) => item.spotifyTrackId === input.spotifyTrackId,
  );

  if (!candidate) {
    throw new ProbableLikePilotCandidateNotFoundError();
  }

  const evaluatedAt = new Date();
  return prisma.probableLikePilotFeedback.upsert({
    where: {
      userId_spotifyTrackId: {
        userId: input.userId,
        spotifyTrackId: input.spotifyTrackId,
      },
    },
    create: {
      userId: input.userId,
      spotifyTrackId: candidate.spotifyTrackId,
      trackName: candidate.trackName,
      artistName: candidate.artistName,
      verdict: input.verdict,
      candidateScore: candidate.score,
      candidateReasons: candidate.reasons,
      evaluatedAt,
    },
    update: {
      trackName: candidate.trackName,
      artistName: candidate.artistName,
      verdict: input.verdict,
      candidateScore: candidate.score,
      candidateReasons: candidate.reasons,
      evaluatedAt,
    },
  });
}

export class ProbableLikePilotCandidateNotFoundError extends Error {
  constructor() {
    super("A faixa não faz mais parte do ranking de provável curtida.");
    this.name = "ProbableLikePilotCandidateNotFoundError";
  }
}
