import { prisma } from "@/lib/prisma";
import { LastFmSimilarityClient } from "@/services/lastfm/similarity";
import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type AcquiredExternalDiscoveryCandidate,
  type ExternalDiscoveryArtistSeed,
  type ExternalDiscoveryTrackSeed,
} from "@/services/music-discovery/external-discovery";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "@/services/music-discovery/profile";
import { buildDiscoveryGate22ScoringReport } from "@/services/music-discovery/scoring-gate2-2";
import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";

type Args = {
  email: string;
  artistSeeds: number;
  trackSeeds: number;
  perSeed: number;
  topN: number;
  json: boolean;
};

const PROFILE_POOL_SIZE = 100;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure LASTFM_API_KEY before running DISCOVERY-01 Gate 5A");
  }

  const user = await prisma.user.findUnique({
    where: { email: args.email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Sonoriza user not found for ${args.email}`);

  const [profile, trackIdentities] = await Promise.all([
    getMusicDiscoveryProfile(user.id, { topN: PROFILE_POOL_SIZE }),
    getDiscoveryTrackIdentityEvidence(user.id),
  ]);
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
  const scoring = buildDiscoveryGate22ScoringReport({
    generatedAt: profile.generatedAt,
    dormantDays: profile.heuristics.dormantDays,
    rediscoveryGapDays: profile.heuristics.rediscoveryGapDays,
    topN: PROFILE_POOL_SIZE,
    artists,
    tracks,
    trackIdentities,
    candidateUniverse: "DIAGNOSTIC_PARTIAL",
  });

  const artistAffinityByName = new Map(
    scoring.topArtistAffinity.map((row) => [normalized(row.artistName), row.score / 100] as const),
  );
  const artistSeeds: ExternalDiscoveryArtistSeed[] = scoring.topArtistAffinity
    .slice(0, args.artistSeeds)
    .map((row) => ({
      artistName: row.artistName,
      affinity: row.score / 100,
    }));

  const trackSeedCandidates = uniqueScoredTracks([
    ...scoring.familiarCandidates,
    ...scoring.rediscoveryCandidates,
  ]).slice(0, args.trackSeeds);
  const trackSeeds: ExternalDiscoveryTrackSeed[] = trackSeedCandidates.map((row) => ({
    artistName: row.artistName,
    trackName: row.trackName,
    artistAffinity: artistAffinityByName.get(normalized(row.artistName)) ?? row.score / 100,
    trackAffinity: row.score / 100,
  }));

  const acquisition = await acquireLastFmExternalDiscovery({
    provider: new LastFmSimilarityClient({ apiKey }),
    artistSeeds,
    trackSeeds,
    perSeed: args.perSeed,
    maxCandidates: Math.max(args.topN * 4, 50),
  });

  const historyIndex = await getKnownArtistHistory(user.id, acquisition.candidates);
  const evaluation = evaluateExternalDiscoveryCandidates({
    candidates: acquisition.candidates,
    knownHistoricalPlayCount: (candidate) => knownArtistPlayCount(candidate, historyIndex),
    topN: args.topN,
  });

  const payload = {
    user: user.email ?? user.id,
    generatedAt: new Date(),
    gate: "DISCOVERY-01 Gate 5A",
    mode: "READ_ONLY",
    historyPolicy: "ARTIST_ANY_HISTORY_IS_KNOWN",
    seeds: {
      artists: artistSeeds,
      tracks: trackSeeds,
    },
    acquisition,
    evaluation: {
      evaluatedCount: evaluation.evaluated.length,
      eligibleCount: evaluation.eligible.length,
      knownHistoryRejectedCount: evaluation.evaluated.filter(
        (row) => row.knownHistoricalPlayCount > 0,
      ).length,
      eligible: evaluation.eligible,
      rejectedKnownHistory: evaluation.evaluated
        .filter((row) => row.knownHistoricalPlayCount > 0)
        .slice(0, args.topN),
    },
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5A EXTERNAL READ-ONLY ==========");
  console.log(`User:                 ${payload.user}`);
  console.log(`Artist seeds:         ${artistSeeds.length}`);
  console.log(`Track seeds:          ${trackSeeds.length}`);
  console.log(`Last.fm calls:        ${acquisition.providerCalls}`);
  console.log(`Acquired candidates: ${acquisition.candidates.length}`);
  console.log(`Provider failures:    ${acquisition.failures.length}`);
  console.log(`Eligible new:         ${evaluation.eligible.length}`);
  console.log(`Known-history reject: ${payload.evaluation.knownHistoryRejectedCount}`);
  console.log("History policy:       any prior artist history => not DESCOBERTA in Gate 5A");
  console.log("No writes: no Spotify, MUSIC-03, preference or score persistence.");

  console.log("\nTop DESCOBERTA candidates:");
  if (evaluation.eligible.length === 0) console.log("  (none / category abstained)");
  evaluation.eligible.forEach((row, index) => {
    const subject = row.trackName ? `${row.artistName} — ${row.trackName}` : row.artistName;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${subject} — score=${row.scoreCard.score}, sim=${row.similarity.toFixed(3)}, source=${row.source}, seed=${row.seedArtistName}${row.seedTrackName ? ` — ${row.seedTrackName}` : ""}`,
    );
  });

  if (acquisition.failures.length > 0) {
    console.log("\nProvider failures (category continued/abstained safely):");
    for (const failure of acquisition.failures) {
      console.log(
        `  ${failure.source} seed=${failure.seedArtistName}${failure.seedTrackName ? ` — ${failure.seedTrackName}` : ""}: ${failure.error}`,
      );
    }
  }
}

type HistoryIndex = {
  byArtistName: Map<string, number>;
  byArtistMbid: Map<string, number>;
};

async function getKnownArtistHistory(
  userId: string,
  candidates: AcquiredExternalDiscoveryCandidate[],
): Promise<HistoryIndex> {
  const artistNames = [...new Set(candidates.map((row) => row.artistName))];
  const artistMbids = [
    ...new Set(
      candidates
        .map((row) => row.artistMbid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  const [nameRows, mbidRows] = await Promise.all([
    artistNames.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["artistName"],
          where: {
            userId,
            artistName: { in: artistNames, mode: "insensitive" },
          },
          _count: { _all: true },
        }),
    artistMbids.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["artistMbid"],
          where: {
            userId,
            artistMbid: { in: artistMbids },
          },
          _count: { _all: true },
        }),
  ]);

  const byArtistName = new Map<string, number>();
  for (const row of nameRows) {
    const key = normalized(row.artistName);
    byArtistName.set(key, (byArtistName.get(key) ?? 0) + row._count._all);
  }
  const byArtistMbid = new Map<string, number>();
  for (const row of mbidRows) {
    if (!row.artistMbid) continue;
    byArtistMbid.set(row.artistMbid, (byArtistMbid.get(row.artistMbid) ?? 0) + row._count._all);
  }
  return { byArtistName, byArtistMbid };
}

function knownArtistPlayCount(
  candidate: AcquiredExternalDiscoveryCandidate,
  history: HistoryIndex,
): number {
  const byName = history.byArtistName.get(normalized(candidate.artistName)) ?? 0;
  const byMbid = candidate.artistMbid
    ? history.byArtistMbid.get(candidate.artistMbid) ?? 0
    : 0;
  return Math.max(byName, byMbid);
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

function uniqueScoredTracks<T extends { spotifyTrackId: string; score: number }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const current = byId.get(row.spotifyTrackId);
    if (!current || row.score > current.score) byId.set(row.spotifyTrackId, row);
  }
  return [...byId.values()].sort((left, right) => right.score - left.score);
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
  let artistSeeds = 5;
  let trackSeeds = 5;
  let perSeed = 10;
  let topN = 30;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length).trim();
      continue;
    }
    if (arg.startsWith("--artist-seeds=")) {
      artistSeeds = boundedArg(arg, "--artist-seeds=", 1, 20);
      continue;
    }
    if (arg.startsWith("--track-seeds=")) {
      trackSeeds = boundedArg(arg, "--track-seeds=", 0, 20);
      continue;
    }
    if (arg.startsWith("--per-seed=")) {
      perSeed = boundedArg(arg, "--per-seed=", 1, 100);
      continue;
    }
    if (arg.startsWith("--top=")) {
      topN = boundedArg(arg, "--top=", 1, 100);
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, artistSeeds, trackSeeds, perSeed, topN, json };
}

function boundedArg(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be an integer between ${min} and ${max}`);
  }
  return value;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
