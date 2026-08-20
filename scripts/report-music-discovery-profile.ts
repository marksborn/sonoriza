import { prisma } from "@/lib/prisma";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "@/services/music-discovery/profile";

type Args = {
  email: string;
  topN: number;
  asOf: Date | undefined;
  json: boolean;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const report = await getMusicDiscoveryProfile(user.id, {
    asOf: args.asOf,
    topN: args.topN,
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 1 READ-ONLY ==========");
  console.log(`User:                    ${user.email ?? user.id}`);
  console.log(`Generated at:            ${report.generatedAt.toISOString()}`);
  console.log(`Timeline events:         ${report.coverage.totalCanonicalEvents}`);
  console.log(`First play:              ${iso(report.coverage.firstPlayedAt)}`);
  console.log(`Last play:               ${iso(report.coverage.lastPlayedAt)}`);
  console.log(`Last.fm valid from:      ${iso(report.coverage.lastFmValidFrom)}`);
  console.log(`Legacy Last.fm excluded:${report.coverage.invalidLegacyLastFmExcluded}`);
  console.log(`Spotify-ID events:       ${report.coverage.canonicalSpotifyIdentityEvents}`);
  console.log(`Unresolved events:       ${report.coverage.unresolvedIdentityEvents}`);
  console.log(`Extended evidence:       ${report.coverage.extendedEvidenceEvents}`);
  console.log(`msPlayed evidence:       ${report.coverage.msPlayedEvidenceEvents}`);
  console.log(`Explicit skips:          ${report.coverage.explicitSkipEvents}`);
  console.log(`Inferred skips:          ${report.coverage.inferredSkipSignals}`);
  console.log(`Pending inferred skips:  ${report.coverage.pendingInferredSkipSignals}`);
  console.log("Sources:");
  for (const source of report.coverage.sourceCounts) {
    console.log(`  ${source.source.padEnd(28)} ${source.count}`);
  }

  console.log("\nCooldown MUSIC-01:");
  console.log(`  enabled:        ${report.cooldown.enabled}`);
  console.log(`  complete:       ${report.cooldown.complete}`);
  console.log(`  window:         ${report.cooldown.windowValue ?? "-"} ${report.cooldown.windowUnit ?? "-"}`);
  console.log(`  cutoff:         ${iso(report.cooldown.cutoff)}`);
  console.log(`  blocked tracks: ${report.cooldown.blockedTrackCount}`);

  printArtists("Top artists — historical", report.topArtistsHistorical);
  printArtists("Top artists — 30 days", report.topArtists30d);
  printArtists("Top artists — 90 days", report.topArtists90d);
  printArtists("Top artists — 365 days", report.topArtists365d);
  printArtists("Recent momentum — absolute 30d delta", report.recentMomentum);
  printArtists("Dormant historical favorites", report.dormantFavorites);
  printArtists("Rediscovery returns", report.rediscoveryReturns);
  printTracks("Top canonical tracks — historical", report.topTracksHistorical);
  printTracks("FAMILIAR candidates — cooldown eligible", report.familiarCandidates);
  printTracks("REDESCOBERTA candidates — dormant + eligible", report.rediscoveryCandidates);

  console.log("\nGate 1 is read-only: no Spotify writes, no Last.fm calls, no playlist generation, no score persistence.");
  console.log(`Heuristics: dormant=${report.heuristics.dormantDays}d, rediscovery-gap=${report.heuristics.rediscoveryGapDays}d.`);
}

function printArtists(title: string, rows: DiscoveryArtistProfile[]) {
  console.log(`\n${title}:`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  rows.forEach((row, index) => {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${row.artistName} — plays=${row.playCount}, 30d=${row.plays30d}, prev30d=${row.previous30d}, delta=${signed(row.momentumDelta30d)}, days=${row.distinctListeningDays}, explicitSkip=${row.explicitSkipCount}, inferredSkip=${row.inferredSkipCount}${row.rediscoveryGapDays === null ? "" : `, returnGap=${row.rediscoveryGapDays}d`}`,
    );
  });
}

function printTracks(title: string, rows: DiscoveryTrackProfile[]) {
  console.log(`\n${title}:`);
  if (rows.length === 0) {
    console.log("  (none)");
    return;
  }
  rows.forEach((row, index) => {
    const eligibility = row.cooldownEligible === null
      ? "unknown"
      : row.cooldownEligible
        ? "eligible"
        : "cooldown";
    console.log(
      `  ${String(index + 1).padStart(2)}. ${row.artistName} — ${row.trackName} — plays=${row.playCount}, 30d=${row.plays30d}, ${eligibility}, extended=${row.extendedEvidenceCount}, explicitSkip=${row.explicitSkipCount}, inferredSkip=${row.inferredSkipCount}`,
    );
  });
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let topN = 10;
  let asOf: Date | undefined;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--top=")) {
      topN = Number(arg.slice("--top=".length));
      if (!Number.isInteger(topN) || topN < 1 || topN > 100) {
        throw new Error("--top must be an integer between 1 and 100");
      }
      continue;
    }
    if (arg.startsWith("--as-of=")) {
      const parsed = new Date(arg.slice("--as-of=".length));
      if (Number.isNaN(parsed.getTime())) throw new Error("--as-of must be a valid ISO date/time");
      asOf = parsed;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, topN, asOf, json };
}

function iso(value: Date | null): string {
  return value?.toISOString() ?? "-";
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
