import { prisma } from "@/lib/prisma";
import {
  getProbableLikeShadow,
  type ProbableLikeShadowResult,
} from "./probable-like";
import { probableLikeTrackIdentityKey } from "./probable-like-spotify-identity";

export const PROBABLE_LIKE_COOLDOWN_DAYS = 90;
const DAY_MS = 86_400_000;

export class ProbableLikeDismissalCandidateNotFoundError extends Error {
  constructor() {
    super("A faixa não está mais disponível entre as sugestões atuais.");
    this.name = "ProbableLikeDismissalCandidateNotFoundError";
  }
}

export async function dismissProbableLike(input: {
  userId: string;
  spotifyTrackId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const shadow = await getProbableLikeShadow(input.userId, { now, limit: 25 });
  const candidate = shadow.candidates.find(
    (item) => item.spotifyTrackId === input.spotifyTrackId,
  );
  if (!candidate) throw new ProbableLikeDismissalCandidateNotFoundError();

  const suppressUntil = new Date(
    now.getTime() + PROBABLE_LIKE_COOLDOWN_DAYS * DAY_MS,
  );

  return prisma.historyProbableLikeDismissal.upsert({
    where: {
      userId_spotifyTrackId_source: {
        userId: input.userId,
        spotifyTrackId: candidate.spotifyTrackId,
        source: "PROBABLE_LIKE",
      },
    },
    create: {
      userId: input.userId,
      spotifyTrackId: candidate.spotifyTrackId,
      source: "PROBABLE_LIKE",
      trackName: candidate.trackName,
      artistName: candidate.artistName,
      candidateScore: candidate.score,
      candidateReasons: candidate.reasons,
      firstDismissedAt: now,
      lastDismissedAt: now,
      suppressUntil,
    },
    update: {
      trackName: candidate.trackName,
      artistName: candidate.artistName,
      candidateScore: candidate.score,
      candidateReasons: candidate.reasons,
      lastDismissedAt: now,
      suppressUntil,
      dismissCount: { increment: 1 },
    },
  });
}

export async function applyProbableLikeCooldowns(
  userId: string,
  result: ProbableLikeShadowResult,
  now = new Date(),
): Promise<{ result: ProbableLikeShadowResult; excludedCooldownCount: number }> {
  const rows = await prisma.historyProbableLikeDismissal.findMany({
    where: {
      userId,
      source: "PROBABLE_LIKE",
      suppressUntil: { gt: now },
    },
    select: {
      spotifyTrackId: true,
      trackName: true,
      artistName: true,
    },
  });

  if (rows.length === 0) {
    return { result, excludedCooldownCount: 0 };
  }

  const trackIds = new Set(rows.map((row) => row.spotifyTrackId));
  const identityKeys = new Set<string>();
  for (const row of rows) {
    const key = probableLikeTrackIdentityKey({
      trackName: row.trackName,
      artistName: row.artistName,
    });
    if (key) identityKeys.add(key);
  }

  const candidates = result.candidates.filter((candidate) => {
    if (trackIds.has(candidate.spotifyTrackId)) return false;
    const key = probableLikeTrackIdentityKey(candidate);
    return key === null || !identityKeys.has(key);
  });

  return {
    result: { ...result, candidates },
    excludedCooldownCount: result.candidates.length - candidates.length,
  };
}
