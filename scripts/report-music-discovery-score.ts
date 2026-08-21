import { prisma } from "@/lib/prisma";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "@/services/music-discovery/profile";
import {
  buildDiscoveryScoringReport,
  type DiscoveryArtistScoreCard,
  type DiscoveryScoredArtistCandidate,
  type DiscoveryScoredTrackCandidate,
} from "@/services/music-discovery/scoring";

type Args = {
  email: string;
  topN: number;
  asOf: Date | undefined;
  json: boolean;
};

const PROFILE_POOL_SIZE = 100;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const profile = await getMusicDiscoveryProfile(user.id, {
    asOf: args.asOf,
    topN: PROFILE_POOL_SIZE,
  });
  const artists = uniqueArtists([
    ...profile.topArtistsHistorical,
    ...profile.topArtists30d,
    ...profile.topArtists90d,
    ...profile.topArtists365d,
    ...profile.recentMomentum,
    ...profile.dormantFavorites,
    ...profile.rediscoveryReturns,
  ]);
  const tracks = uniqueTracks([
    ...profile.topTracksHistorical,
    ...profile.familiarCandidates,
    ...profile.rediscoveryCandidates,
  ]);

  const scoring = buildDiscoveryScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: args.topN,
    artists,
    tracks,
  });

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          user: user.email ?? user.id,
          profileGeneratedAt: profile.generatedAt,
          candidatePool: { artists: artists.length, tracks: tracks.length },
          scoring,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 2 SCORE READ-ONLY ==========");
  console.log(`User:              ${user.email ?? user.id}`);
  console.log(`Generated at:      ${profile.generatedAt.toISOString()}`);
  console.log(`Score version:     ${scoring.version}`);
  console.log(`Candidate pool:    ${artists.length} artists / ${tracks.length} tracks`);
  console.log("No writes: profile + scores only; no inbox, playlist or preference persistence.");

  printArtistAffinity("Top artist affinity", scoring.topArtistAffinity);
  printTracks("FAMILIAR — score + MUSIC-01 eligibility", scoring.familiarCandidates);
  printTracks("REDESCOBERTA — dormant tracks", scoring.rediscoveryCandidates);
  printArtists("REDISCOVERY_RETURN — artists back after a long gap", scoring.rediscoveryReturns);
  printArtists("APROFUNDAMENTO — artist signals for ALBUM-01", scoring.deepeningCandidates);

  console.log("\nDESCOBERTA:");
  console.log(`  ${scoring.externalDiscovery.status}: ${scoring.externalDiscovery.note}`);
}

function printArtistAffinity(title: string, rows: DiscoveryArtistScoreCard[]) {
  console.log(`\n${title}:`);
  rows.forEach((row, index) => {
    console.log(
      `  ${rank(index)} ${row.artistName} — score=${row.score}, historical=${row.components.historicalAffinity}, recent=${row.components.recentAffinity}, momentum=${row.components.momentum}, skipAdj=${row.components.adjustedExplicitSkipRate} — ${reasonCodes(row.reasons)}`,
    );
  });
}

function printTracks(title: string, rows: DiscoveryScoredTrackCandidate[]) {
  console.log(`\n${title}:`);
  if (rows.length === 0) return console.log("  (none)");
  rows.forEach((row, index) => {
    console.log(
      `  ${rank(index)} ${row.artistName} — ${row.trackName} — score=${row.score}, history=${row.components.trackHistoricalStrength}, artist=${row.components.artistHistoricalAffinity}, dormancy=${row.components.dormancy}, negative=${row.components.negativePenalty} — ${reasonCodes(row.reasons)}`,
    );
  });
}

function printArtists(title: string, rows: DiscoveryScoredArtistCandidate[]) {
  console.log(`\n${title}:`);
  if (rows.length === 0) return console.log("  (none)");
  rows.forEach((row, index) => {
    console.log(
      `  ${rank(index)} ${row.artistName} — score=${row.score}, historical=${row.components.historicalAffinity}, recent=${row.components.recentAffinity}, momentum=${row.components.momentum}, dormancy=${row.components.rediscoveryDormancy}, negative=${row.components.negativePenalty} — ${reasonCodes(row.reasons)}`,
    );
  });
}

function reasonCodes(reasons: Array<{ code: string }>): string {
  return reasons.map((reason) => reason.code).join(", ") || "NO_STRONG_REASON";
}

function rank(index: number): string {
  return `${String(index + 1).padStart(2)}.`;
}

function uniqueArtists(rows: DiscoveryArtistProfile[]): DiscoveryArtistProfile[] {
  const byKey = new Map<string, DiscoveryArtistProfile>();
  for (const row of rows) byKey.set(normalized(row.artistName), row);
  return [...byKey.values()];
}

function uniqueTracks(rows: DiscoveryTrackProfile[]): DiscoveryTrackProfile[] {
  const byId = new Map<string, DiscoveryTrackProfile>();
  for (const row of rows) byId.set(row.spotifyTrackId, row);
  return [...byId.values()];
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function parseArgs(argv: string[]): Args {
  let email = "";
  let topN = 20;
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

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
