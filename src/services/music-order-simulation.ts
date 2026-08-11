import { prisma } from "@/lib/prisma";
import { readConfigurationFingerprint } from "@/services/configuration-readiness";
import { readMusicOrderSeedsFromSummary } from "@/services/playlist-ordering";

export async function findReusableSimulationMusicOrderSeeds(
  userId: string,
  configurationFingerprint: string,
): Promise<Record<string, string> | undefined> {
  const latestRealAttempt = await prisma.generationRun.findFirst({
    where: { userId, simulation: false },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  const simulations = await prisma.generationRun.findMany({
    where: {
      userId,
      simulation: true,
      status: "SUCCESS",
      ...(latestRealAttempt
        ? { startedAt: { gt: latestRealAttempt.startedAt } }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: { summary: true },
  });

  for (const simulation of simulations) {
    if (readConfigurationFingerprint(simulation.summary) !== configurationFingerprint) {
      continue;
    }
    const seeds = readMusicOrderSeedsFromSummary(simulation.summary);
    if (Object.keys(seeds).length > 0) return seeds;
  }

  return undefined;
}
