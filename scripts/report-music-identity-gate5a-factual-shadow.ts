import { prisma } from "@/lib/prisma";
import { reportGate5ACanonicalFactualCooldown } from "@/services/music-identity/canonical-factual-cooldown-shadow-report";

function flag(key: string): string | null {
  const prefix = `--${key}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

async function main(): Promise<void> {
  const allowed = ["--json", "--user=", "--target="];
  for (const arg of process.argv.slice(2)) {
    if (!allowed.some((value) => value.endsWith("=") ? arg.startsWith(value) : arg === value)) {
      throw new Error(`Unknown or unsafe option: ${arg}`);
    }
  }
  const userId = flag("user");
  const targetPlaylistId = flag("target");
  if (!userId || !targetPlaylistId) {
    throw new Error("Usage: npx tsx scripts/report-music-identity-gate5a-factual-shadow.ts --user=<id> --target=<id> [--json]");
  }

  const report = await reportGate5ACanonicalFactualCooldown({ userId, targetPlaylistId });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("=== MUSIC-IDENTITY-01 Gate 5A: LOCAL FACTUAL SHADOW / READ ONLY ===");
  console.log(`Target: ${report.targetName} / run: ${report.sourceRunId ?? "none"}`);
  console.log(`Status: ${report.abstention ?? "MEASURED"}`);
  console.log("Coverage: local persisted Last.fm only (NOT live provider coverage)");
  console.log("Spotify writes / DB writes / planner influence: false / false / false");
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`${key.padEnd(36)}${value}`);
  }
  console.log("Samples (bounded):");
  console.log(JSON.stringify(report.samples, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
