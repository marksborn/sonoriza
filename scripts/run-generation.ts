/**
 * CLI runner for the generation engine.
 *
 *   npm run generate:run -- --user <userId> [--simulate]
 *
 * Useful for local testing and for a system-cron entry that prefers a Node
 * process over an HTTP call.
 */
import { generatePlaylists } from "@/jobs/generate-playlists";
import { prisma } from "@/lib/prisma";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const userId = arg("user");
  const simulate = process.argv.includes("--simulate");

  if (!userId) {
    console.error("Usage: npm run generate:run -- --user <userId> [--simulate]");
    process.exit(1);
  }

  console.log(`Generating for user ${userId}${simulate ? " (simulate)" : ""}...`);
  const result = await generatePlaylists({
    userId,
    trigger: simulate ? "SIMULATION" : "MANUAL",
    simulate,
  });

  const run = await prisma.generationRun.findUnique({
    where: { id: result.runId },
    include: { logs: { orderBy: { createdAt: "asc" } } },
  });

  for (const line of run?.logs ?? []) {
    console.log(`  [${line.level}] ${line.message}`);
  }
  console.log(`Run ${result.runId} → ${result.status}`);
  console.log(JSON.stringify(run?.summary, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
