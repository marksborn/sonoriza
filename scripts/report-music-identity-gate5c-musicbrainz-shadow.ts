import { prisma } from "@/lib/prisma";
import { reportGate5CIsrcMbidShadow } from "@/services/music-identity/musicbrainz-isrc-mbid-shadow-report";
import {
  parseGate5CHistoricalPositions,
  validateGate5CHistoricalSelection,
} from "@/services/music-identity/musicbrainz-isrc-mbid-shadow-selection";

function argValue(name: string): string | null {
  const prefix = "--" + name + "=";
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = [
    "--user=", "--target=", "--offset=", "--limit=",
    "--run-id=", "--positions=",
    "--json", "--ack-provider-reads",
  ];
  for (const arg of args) {
    if (!allowed.some((key) => key.endsWith("=") ? arg.startsWith(key) : arg === key)) {
      throw new Error("Gate 5C: unsupported/unsafe option: " + arg);
    }
  }

  for (const key of ["--user=", "--target=", "--offset=", "--limit=", "--run-id=", "--positions="]) {
    if (args.filter((arg) => arg.startsWith(key)).length > 1) {
      throw new Error("Gate 5D.3: duplicate CLI option: " + key);
    }
  }

  const userId = argValue("user");
  const targetPlaylistId = argValue("target");
  if (!userId || !targetPlaylistId || !args.includes("--ack-provider-reads")) {
    throw new Error(
      "Usage: npx tsx scripts/report-music-identity-gate5c-musicbrainz-shadow.ts " +
      "--user=<id> --target=<id> [--offset=0] [--limit=3] " +
      "[--run-id=<real-successful-run> --positions=5,9,10] " +
      "--ack-provider-reads [--json]. Requires manual external-provider consent.",
    );
  }

  const offset = Number(argValue("offset") ?? "0");
  const limit = Number(argValue("limit") ?? "3");

  if (args.some((arg) => arg.startsWith("--run-id=")) && !argValue("run-id")) {
    throw new Error("Gate 5D.3: --run-id must not be empty");
  }
  if (args.some((arg) => arg.startsWith("--positions=")) && !argValue("positions")) {
    throw new Error("Gate 5D.3: --positions must not be empty");
  }
  const historicalPositions = argValue("positions");
  const selection = validateGate5CHistoricalSelection({
    runId: argValue("run-id"),
    positions: historicalPositions === null
      ? null : parseGate5CHistoricalPositions(historicalPositions),
    paginationRequested: historicalPositions !== null && args.some(
      (arg) => arg.startsWith("--offset=") || arg.startsWith("--limit=")
    ),
  });

  const report = await reportGate5CIsrcMbidShadow({
    userId, targetPlaylistId, offset, limit,
    runId: selection.runId,
    positions: selection.positions,
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("MUSIC-IDENTITY-01 Gate 5C / ISRC->MusicBrainz MBID / SHADOW ONLY");
  console.log("Target:", report.targetName, "run:", report.sourceRunId);
  console.log("Window:", report.cutoff, "..", report.sourceRunStartedAt);
  console.log("Provider requests:", JSON.stringify(report.metrics));
  for (const row of report.rows) console.log(JSON.stringify(row));
  console.log("No canonical merge, no playlist write, no productive cooldown activation.");
}

main()
  .catch((error: unknown) => {
    console.error("GATE 5C ABORTED:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
