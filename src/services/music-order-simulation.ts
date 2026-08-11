import { prisma } from "@/lib/prisma";
import { readConfigurationFingerprint } from "@/services/configuration-readiness";
import {
  readMusicOrderEvidenceFromSummary,
  type ReusableMusicOrderEvidence,
} from "@/services/playlist-ordering";

function summaryQualityPassed(summary: unknown): boolean {
  return Boolean(
    summary &&
      typeof summary === "object" &&
      !Array.isArray(summary) &&
      (summary as Record<string, unknown>).qualityPassed === true,
  );
}

/**
 * Returns one-shot ORDER-01 evidence only from a current, quality-approved
 * simulation that happened after the latest real run capable of writing.
 * FAILED real attempts do not consume the preview because they are expected to
 * have stopped before publication; SUCCESS/PARTIAL do.
 */
export async function findReusableSimulationMusicOrderEvidence(
  userId: string,
  configurationFingerprint: string,
): Promise<Record<string, ReusableMusicOrderEvidence> | undefined> {
  const latestAppliedRealRun = await prisma.generationRun.findFirst({
    where: {
      userId,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
    },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  const simulations = await prisma.generationRun.findMany({
    where: {
      userId,
      simulation: true,
      status: "SUCCESS",
      ...(latestAppliedRealRun
        ? { startedAt: { gt: latestAppliedRealRun.startedAt } }
        : {}),
    },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: { summary: true },
  });

  for (const simulation of simulations) {
    if (!summaryQualityPassed(simulation.summary)) continue;
    if (readConfigurationFingerprint(simulation.summary) !== configurationFingerprint) {
      continue;
    }
    const evidence = readMusicOrderEvidenceFromSummary(simulation.summary);
    if (Object.keys(evidence).length > 0) return evidence;
  }

  return undefined;
}
