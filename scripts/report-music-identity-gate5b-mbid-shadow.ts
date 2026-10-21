import { prisma } from "@/lib/prisma";
import { reportGate5BMbidLinkage } from "@/services/music-identity/canonical-factual-mbid-linkage-shadow-report";

function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

async function main(): Promise<void> {
  const allowed = ["--json", "--user=", "--target="];
  for (const arg of process.argv.slice(2)) {
    if (!allowed.some((prefix) =>
      prefix.endsWith("=") ? arg.startsWith(prefix) : arg === prefix
    )) {
      throw new Error(`Unsupported or unsafe option: ${arg}`);
    }
  }

  const userId = value("user");
  const targetPlaylistId = value("target");
  if (!userId || !targetPlaylistId) {
    throw new Error(
      "Usage: npx tsx scripts/report-music-identity-gate5b-mbid-shadow.ts --user=<id> --target=<id> [--json]",
    );
  }

  const report = await reportGate5BMbidLinkage({ userId, targetPlaylistId });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("MUSIC-IDENTITY-01 Gate 5B / LOCAL LAST.FM MBID AUDIT / READ ONLY");
  console.log(`Target: ${report.targetName}; historical run: ${report.sourceRunId ?? "none"}`);
  console.log(`Result: ${report.abstention ?? "MEASURED"}`);
  console.log("Coverage: LOCAL LOWER BOUND ONLY. MBID matches are NOT canonical recording proof.");
  console.log("Spotify writes / DB writes / canonical mutation / planner influence: NONE");
  for (const [key, count] of Object.entries(report.counts)) {
    console.log(`${key.padEnd(42)}${count}`);
  }
  console.log("Bounded samples:");
  console.log(JSON.stringify(report.samples, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
