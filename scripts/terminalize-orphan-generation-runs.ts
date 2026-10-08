/**
 * #435: lists (default) or terminalizes GenerationRuns stuck in RUNNING.
 *
 *   npm run runs:orphans                       # dry run, prints candidates
 *   npm run runs:orphans -- --apply            # marks them FAILED
 *   npm run runs:orphans -- --min-age-hours 6  # default 2
 *
 * Only touches GenerationRun/GenerationLog rows. Never calls Spotify.
 */
import {
  DEFAULT_ORPHAN_MIN_AGE_MS,
  findOrphanGenerationRuns,
  terminalizeOrphanGenerationRuns,
} from "@/jobs/orphan-generation-runs";
import { prisma } from "@/lib/prisma";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const hours = arg("min-age-hours");
  const minAgeMs = hours ? Number(hours) * 60 * 60 * 1000 : DEFAULT_ORPHAN_MIN_AGE_MS;
  if (!Number.isFinite(minAgeMs) || minAgeMs < 60 * 60 * 1000) {
    console.error("--min-age-hours must be a number >= 1");
    process.exit(1);
  }

  const now = new Date();
  const orphans = await findOrphanGenerationRuns(now, minAgeMs);
  console.log(
    `${orphans.length} GenerationRun(s) RUNNING older than ${minAgeMs / 3_600_000}h without an active scheduler attempt:`,
  );
  for (const orphan of orphans) {
    console.log(
      `  ${orphan.id}  ${orphan.trigger}${orphan.simulation ? " (simulation)" : ""}  ` +
        `started ${orphan.startedAt.toISOString()}  last checkpoint ${orphan.lastCheckpoint ?? "-"}`,
    );
  }

  if (!apply) {
    console.log("Dry run. Re-run with --apply to mark them FAILED.");
    return;
  }

  const terminalized = await terminalizeOrphanGenerationRuns(orphans, now);
  console.log(`Terminalized ${terminalized.length}/${orphans.length}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
