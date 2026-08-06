import { prisma } from "@/lib/prisma";

import { generatePlaylists } from "./generate-playlists";

/**
 * Runs the daily generation for every user that has at least one enabled
 * target playlist. Invoked by the server cron via POST /api/cron/generate.
 *
 * Users are processed sequentially to stay well within Spotify/Google rate
 * limits; failures are isolated so one user cannot block the others.
 */
export async function runScheduledGeneration(): Promise<{
  processed: number;
  results: { userId: string; runId: string; status: string }[];
}> {
  const users = await prisma.user.findMany({
    where: { targetPlaylists: { some: { enabled: true } } },
    select: { id: true },
  });

  const results: { userId: string; runId: string; status: string }[] = [];

  for (const user of users) {
    try {
      const { runId, status } = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
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
