import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import { findReusableSimulationMusicOrderSeeds } from "@/services/music-order-simulation";

import { generatePlaylists } from "./generate-playlists";

/**
 * Runs the daily generation for every allowed user that has at least one
 * enabled target playlist. Invoked by the server cron via POST /api/cron/generate.
 *
 * Users are processed sequentially to stay well within Spotify/Google rate
 * limits; failures are isolated so one user cannot block the others.
 * Scheduled real generation is subject to the same current-configuration
 * readiness gate as a manual real run and to AUTH-01 before provider access.
 */
export async function runScheduledGeneration(): Promise<{
  processed: number;
  results: { userId: string; runId: string; status: string }[];
}> {
  const users = (
    await prisma.user.findMany({
      where: { targetPlaylists: { some: { enabled: true } } },
      select: { id: true, email: true },
    })
  ).filter((user) => isEmailAllowed(user.email));

  const results: { userId: string; runId: string; status: string }[] = [];

  for (const user of users) {
    try {
      const assessment = await assessConfiguration(user.id);
      const gate = await getFirstRunGate(user.id, assessment);

      if (!gate.realRunAllowed) {
        results.push({
          userId: user.id,
          runId: "",
          status: `blocked: ${gate.reason ?? "simulação atual não aprovada"}`,
        });
        continue;
      }

      const musicOrderSeeds = await findReusableSimulationMusicOrderSeeds(
        user.id,
        assessment.fingerprint,
      );
      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
        musicOrderSeeds,
      });
      results.push({ userId: user.id, runId, status });
    } catch (err) {
      results.push({
        userId: user.id,
        runId: "",
        status: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { processed: users.length, results };
}
