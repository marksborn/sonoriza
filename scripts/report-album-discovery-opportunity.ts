import { prisma } from "@/lib/prisma";
import { getAlbumOpportunityReport } from "@/services/album-discovery/opportunity-report";

const args = parseArgs(process.argv.slice(2));

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await getAlbumOpportunityReport(user.id, {
    asOf: args.asOf,
    artistLimit: args.artists,
    top: args.top,
  });
  const payload = {
    gate: "ALBUM-01 Gate 5",
    mode: "READ_ONLY",
    user: user.email ?? user.id,
    ...report,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== ALBUM-01 — GATE 5 OPPORTUNITY + QUEUED MEMORY READ-ONLY ==========");
  console.log(`User:                    ${payload.user}`);
  console.log(`As of:                   ${report.asOf.toISOString()}`);
  console.log(`Artists selected:        ${report.scope.selectedArtistCount}/${report.scope.requestedArtistCount}`);
  console.log(`Eligible albums ranked:  ${report.candidateCount}`);
  console.log(`Persisted QUEUED:        ${report.queueMemory.queuedCount}`);
  console.log(`Suppressed by memory:    ${report.queueMemory.suppressedAlbumCount}`);
  console.log(`Provider failures:       ${report.providerMetrics.failures.length}`);
  console.log(`Policy:                  ${report.policy.version} + ${report.queueMemoryPolicy.version}`);
  console.log("Mode:                    READ_ONLY — zero Spotify/database/queue writes");

  console.log("\nArtist resolution:");
  for (const artist of report.artistReports) {
    const identity = artist.historicalArtistIdentity;
    console.log(
      `  ${artist.artistName} — deepening=${artist.artistDeepeningScore}` +
        ` historyId=${identity.status}${identity.primaryArtistId ? `:${identity.primaryArtistId}` : ""}` +
        ` spotify=${artist.resolutionStatus}/${artist.resolutionReason}` +
        ` albums=${artist.scoredAlbumCount}/${artist.catalogAlbumCount}`,
    );
  }

  if (report.queueMemory.suppressedAlbumIds.length > 0) {
    console.log("\nSuppressed exact editions (persisted QUEUED):");
    for (const albumId of report.queueMemory.suppressedAlbumIds) console.log(`  ${albumId}`);
  }

  console.log(`\nTop ${report.ranked.length} album opportunities:`);
  for (const [index, row] of report.ranked.entries()) {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${row.artistName} — ${row.albumName} (${row.releaseDate ?? "?"})` +
        ` — score=${row.score}` +
        ` coverage=${formatRate(row.coverage.analyticCoverage)}` +
        ` canonical=${row.coverage.canonicalObservedTrackCount}/${row.coverage.eligibleTrackCount}` +
        ` labelOnly=${row.coverage.labelOnlyObservedTrackCount}` +
        ` recent30d=${row.coverage.plays30d}` +
        ` skipAdj=${formatRate(row.components.adjustedExplicitSkipRate)}` +
        ` penalty=${row.components.negativePenalty}` +
        ` confidence=${row.coverage.confidence}` +
        ` reasons=${row.reasons.map((reason) => reason.code).join("|") || "(none)"}` +
        ` id=${row.spotifyAlbumId}`,
    );
  }

  if (report.providerMetrics.failures.length > 0) {
    console.log("\nProvider failures (isolated; no writes occurred):");
    for (const failure of report.providerMetrics.failures) {
      console.log(`  ${failure.subject}: ${failure.error}`);
    }
  }
}

type Args = { email: string; artists: number; top: number; asOf: Date; json: boolean };

function parseArgs(argv: string[]): Args {
  let email = "";
  let artists = 5;
  let top = 20;
  let asOf = new Date();
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("--email=")) email = arg.slice(8).trim().toLowerCase();
    else if (arg.startsWith("--artists=")) artists = integerArg(arg, "--artists=", 1, 20);
    else if (arg.startsWith("--top=")) top = integerArg(arg, "--top=", 1, 100);
    else if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("Invalid --as-of date");
      asOf = parsed;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!email) {
    throw new Error(
      "Usage: npm run album:opportunity -- --email=<user> [--artists=5] [--top=20] [--as-of=<ISO>] [--json]",
    );
  }
  return { email, artists, top, asOf, json };
}

function integerArg(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer between ${min} and ${max}`);
  }
  return value;
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
