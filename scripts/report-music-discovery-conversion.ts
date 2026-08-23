import { prisma } from "@/lib/prisma";
import {
  extractDiscoveryExposures,
  measureDiscoveryConversion,
} from "@/services/music-discovery/conversion";

type Args = {
  email: string;
  days: number;
  asOf: Date;
  json: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const since = new Date(args.asOf.getTime() - args.days * 86_400_000);
  const runs = await prisma.generationRun.findMany({
    where: {
      userId: user.id,
      simulation: false,
      status: "SUCCESS",
      startedAt: { gte: since, lte: args.asOf },
    },
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      summary: true,
    },
    orderBy: { startedAt: "asc" },
  });

  const exposures = runs.flatMap((run) => extractDiscoveryExposures(run));
  const earliestExposure = exposures.reduce<Date | null>(
    (earliest, exposure) =>
      !earliest || exposure.exposedAt < earliest ? exposure.exposedAt : earliest,
    null,
  );

  const listeningEvents = earliestExposure
    ? await prisma.trackListeningEvent.findMany({
        where: {
          userId: user.id,
          playedAt: { gt: earliestExposure, lte: args.asOf },
        },
        select: {
          spotifyTrackId: true,
          spotifyUri: true,
          trackName: true,
          artistName: true,
          isrc: true,
          playedAt: true,
          source: true,
        },
        orderBy: { playedAt: "asc" },
      })
    : [];

  const report = measureDiscoveryConversion({
    exposures,
    listeningEvents,
    asOf: args.asOf,
  });
  const payload = {
    gate: "DISCOVERY-01 Gate 5I",
    mode: "READ_ONLY",
    user: user.email ?? user.id,
    window: {
      days: args.days,
      since,
      asOf: args.asOf,
    },
    generationRunsScanned: runs.length,
    listeningEventsScanned: listeningEvents.length,
    report,
    interpretation: {
      causality:
        "Conversion is observational: a later play/exploration is correlated with the discovery exposure, not asserted to have been caused by Sonoriza.",
      negativeSignalMaturity:
        "NEVER_PLAYED is only counted after the policy maturity window; fresh discoveries remain pending rather than negative.",
      identity:
        "Exact Spotify track ID first, then ISRC, then artist/title only for id-less listening evidence.",
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5I CONVERSION READ-ONLY ==========");
  console.log(`User:                         ${payload.user}`);
  console.log(`Window:                       ${args.days} days`);
  console.log(`Generation runs scanned:      ${runs.length}`);
  console.log(`Listening events scanned:     ${listeningEvents.length}`);
  console.log(`Discovery exposures:          ${report.exposureCount}`);
  console.log(`Unique discoveries:           ${report.uniqueDiscoveryCount}`);
  console.log(`Played after discovery:       ${report.playedCount} (${formatRate(report.playedRate)})`);
  console.log(`Replayed:                     ${report.replayedCount} (${formatRate(report.replayedRate)})`);
  console.log(`Artist explored:              ${report.artistExploredCount} (${formatRate(report.artistExploredRate)})`);
  console.log(
    `Never played (mature only): ${report.neverPlayedCount}/${report.matureNeverPlayedEligibleCount} (${formatRate(report.neverPlayedRateAmongMature)})`,
  );
  console.log(
    `Long-term affinity:          ${report.longTermAffinityCount}/${report.matureLongTermEligibleCount} (${formatRate(report.longTermAffinityRateAmongMature)})`,
  );
  console.log(`Policy:                       ${report.policy.version}`);
  console.log("Mode:                         READ_ONLY — no Spotify/database writes");

  if (report.candidates.length === 0) {
    console.log("\nNo applied Gate 5H discovery exposure found in this window.");
    return;
  }

  console.log("\nDiscoveries:");
  for (const [index, row] of report.candidates.entries()) {
    const subject = `${row.artist ?? "(unknown artist)"} — ${row.title}`;
    const states = [
      row.played ? `PLAYED x${row.playsAfterDiscovery}` : "PENDING_PLAY",
      row.replayed ? "REPLAYED" : null,
      row.artistExplored ? "ARTIST_EXPLORED" : null,
      row.neverPlayed ? "NEVER_PLAYED_MATURE" : null,
      row.longTermAffinity ? "LONG_TERM_AFFINITY" : null,
    ].filter(Boolean);
    console.log(
      `  ${String(index + 1).padStart(2)}. ${subject} — ${states.join(", ")}; exposures=${row.exposureCount}; targets=${row.targetNames.join("|") || "?"}; matches=${row.matchSources.join("|") || "none"}; first=${row.firstExposedAt.toISOString()}`,
    );
    if (row.pathLabels.length > 0) {
      console.log(`      provenance=${row.pathLabels.join(" | ")}`);
    }
  }
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let days = 180;
  let asOf = new Date();
  let json = false;

  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim().toLowerCase();
      continue;
    }
    if (arg.startsWith("--days=")) {
      const parsed = Number(arg.slice("--days=".length));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
        throw new Error("--days must be an integer between 1 and 3650");
      }
      days = parsed;
      continue;
    }
    if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid --as-of date");
      asOf = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) {
    throw new Error(
      "Usage: npm run discovery:conversion -- --email=<user> [--days=180] [--as-of=<ISO>] [--json]",
    );
  }

  return { email, days, asOf, json };
}

function formatRate(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
