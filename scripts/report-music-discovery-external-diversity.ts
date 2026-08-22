import { prisma } from "@/lib/prisma";
import { LastFmSimilarityClient } from "@/services/lastfm/similarity";
import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type AcquiredExternalDiscoveryCandidate,
  type EvaluatedExternalDiscoveryCandidate,
  type ExternalDiscoveryArtistSeed,
  type ExternalDiscoveryHistoryEvidence,
  type ExternalDiscoveryTrackSeed,
} from "@/services/music-discovery/external-discovery";
import {
  decorateRootCandidates,
  expandLastFmExternalDiscoverySecondHop,
  mergeDiversifiedExternalDiscoveryCandidates,
  selectArtistDiverseTracks,
  selectDiversifiedArtistSeeds,
  type DiversifiedExternalDiscoveryCandidate,
} from "@/services/music-discovery/external-discovery-diversity";
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
  bridgeSeeds: number;
  bridgePerSeed: number;
  topN: number;
  json: boolean;
};

const PROFILE_POOL_SIZE = 100;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure LASTFM_API_KEY before running DISCOVERY-01 Gate 5C");
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

  const affinityRows = scoring.topArtistAffinity.map((row) => ({
    artistName: row.artistName,
    affinity: row.score / 100,
  }));
  const artistSeeds: ExternalDiscoveryArtistSeed[] = selectDiversifiedArtistSeeds({
    affinity: affinityRows,
    priorityBuckets: [
      scoring.topArtistAffinity.map((row) => row.artistName),
      profile.recentMomentum.map((row) => row.artistName),
      [...profile.rediscoveryReturns, ...profile.dormantFavorites].map((row) => row.artistName),
    ],
    limit: args.artistSeeds,
  });

  const artistAffinityByName = new Map(
    affinityRows.map((row) => [normalized(row.artistName), row.affinity] as const),
  );
  const trackSeedCandidates = selectArtistDiverseTracks(
    [...scoring.familiarCandidates, ...scoring.rediscoveryCandidates],
    args.trackSeeds,
  );
  const trackSeeds: ExternalDiscoveryTrackSeed[] = trackSeedCandidates.map((row) => ({
    artistName: row.artistName,
    trackName: row.trackName,
    artistAffinity: artistAffinityByName.get(normalized(row.artistName)) ?? row.score / 100,
    trackAffinity: row.score / 100,
  }));

  const provider = new LastFmSimilarityClient({ apiKey });
  const rootAcquisition = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds,
    trackSeeds,
    perSeed: args.perSeed,
    maxCandidates: Math.max(args.topN * 6, 100),
  });
  const rootHistory = await getKnownHistory(user.id, rootAcquisition.candidates);
  const rootEvaluation = evaluateExternalDiscoveryCandidates({
    candidates: rootAcquisition.candidates,
    historyEvidence: (candidate) => historyEvidenceFor(candidate, rootHistory),
    topN: args.topN,
  });

  const rootDecorated = decorateRootCandidates(rootAcquisition.candidates);
  const knownArtistCandidateKeys = new Set(
    rootEvaluation.evaluated
      .filter(
        (row) =>
          row.candidateType === "ARTIST" && row.historyClass === "KNOWN_ARTIST_NOT_NEW",
      )
      .map((row) => row.candidateKey),
  );
  const originalSeedArtists = new Set(artistSeeds.map((row) => normalized(row.artistName)));
  const bridges = rootDecorated
    .filter(
      (row) =>
        row.candidateType === "ARTIST" &&
        knownArtistCandidateKeys.has(row.candidateKey) &&
        !originalSeedArtists.has(normalized(row.artistName)),
    )
    .slice(0, args.bridgeSeeds);

  const expansion = await expandLastFmExternalDiscoverySecondHop({
    provider,
    bridges,
    perSeed: args.bridgePerSeed,
    maxCandidates: Math.max(args.topN * 6, 100),
  });
  const combinedCandidates = mergeDiversifiedExternalDiscoveryCandidates({
    root: rootDecorated,
    expanded: expansion.candidates,
    maxCandidates: Math.max(args.topN * 10, 150),
  });
  const combinedHistory = await getKnownHistory(user.id, combinedCandidates);
  const combinedEvaluation = evaluateExternalDiscoveryCandidates({
    candidates: combinedCandidates,
    historyEvidence: (candidate) => historyEvidenceFor(candidate, combinedHistory),
    topN: args.topN,
  });

  const depthByKey = new Map(
    combinedCandidates.map((row) => [row.candidateKey, row.acquisitionDepth] as const),
  );
  const rootMetrics = evaluationMetrics(rootEvaluation.evaluated, rootAcquisition.candidates);
  const combinedMetrics = evaluationMetrics(combinedEvaluation.evaluated, combinedCandidates);
  const depth2EligibleCount = combinedEvaluation.evaluated.filter(
    (row) => row.scoreCard.eligible && depthByKey.get(row.candidateKey) === 2,
  ).length;

  const payload = {
    user: user.email ?? user.id,
    generatedAt: new Date(),
    gate: "DISCOVERY-01 Gate 5C",
    mode: "READ_ONLY",
    policy: {
      seedStrategy: "ROUND_ROBIN_AFFINITY_MOMENTUM_REDISCOVERY__TRACK_ARTIST_DIVERSITY",
      secondHop: "KNOWN_ADJACENT_ARTIST_BRIDGES",
      secondHopConfidence: 0.72,
      secondHopSimilarity: "ROOT_TO_BRIDGE_X_BRIDGE_TO_CANDIDATE",
      history: "ARTIST_BY_ARTIST_HISTORY__TRACK_BY_EXACT_TRACK_HISTORY",
    },
    seeds: {
      artists: artistSeeds,
      tracks: trackSeeds,
      bridges: bridges.map((row) => ({
        artistName: row.artistName,
        rootSeedArtistName: row.rootSeedArtistName,
        similarity: row.similarity,
      })),
    },
    acquisition: {
      root: rootAcquisition,
      secondHop: expansion,
      totalProviderCalls: rootAcquisition.providerCalls + expansion.providerCalls,
      totalProviderFailures: rootAcquisition.failures.length + expansion.failures.length,
      combinedCandidateCount: combinedCandidates.length,
    },
    comparison: {
      root: rootMetrics,
      diversified: {
        ...combinedMetrics,
        depth2CandidateCount: combinedCandidates.filter((row) => row.acquisitionDepth === 2).length,
        depth2EligibleCount,
      },
    },
    eligible: combinedEvaluation.eligible.map((row) => ({
      ...row,
      acquisitionDepth: depthByKey.get(row.candidateKey) ?? 1,
      viaArtistName:
        combinedCandidates.find((candidate) => candidate.candidateKey === row.candidateKey)
          ?.viaArtistName ?? null,
      rootSeedArtistName:
        combinedCandidates.find((candidate) => candidate.candidateKey === row.candidateKey)
          ?.rootSeedArtistName ?? row.seedArtistName,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("========== DISCOVERY-01 — GATE 5C DIVERSITY READ-ONLY ==========");
  console.log(`User:                       ${payload.user}`);
  console.log(`Artist seeds:               ${artistSeeds.length}`);
  console.log(`Track seeds:                ${trackSeeds.length}`);
  console.log(`Bridge seeds:               ${bridges.length}`);
  console.log(`Last.fm calls total:        ${payload.acquisition.totalProviderCalls}`);
  console.log(`Provider failures:          ${payload.acquisition.totalProviderFailures}`);
  console.log(`Root candidates:            ${rootAcquisition.candidates.length}`);
  console.log(`Second-hop candidates:      ${expansion.candidates.length}`);
  console.log(`Combined candidates:        ${combinedCandidates.length}`);
  console.log("");
  console.log("--- Gate 5B-style root pool ---");
  printMetrics(rootMetrics);
  console.log("");
  console.log("--- Gate 5C diversified pool ---");
  printMetrics(combinedMetrics);
  console.log(`Depth-2 candidates:         ${payload.comparison.diversified.depth2CandidateCount}`);
  console.log(`Depth-2 eligible:           ${depth2EligibleCount}`);
  console.log("");
  console.log("Bridge artists:");
  if (bridges.length === 0) console.log("  (none / second hop abstained)");
  bridges.forEach((bridge, index) => {
    console.log(
      `  ${String(index + 1).padStart(2)}. ${bridge.artistName} <- root ${bridge.rootSeedArtistName} (sim=${bridge.similarity.toFixed(3)})`,
    );
  });
  console.log("");
  console.log("Top DESCOBERTA candidates:");
  if (combinedEvaluation.eligible.length === 0) console.log("  (none / category abstained)");
  combinedEvaluation.eligible.forEach((row, index) => {
    const candidate = combinedCandidates.find((item) => item.candidateKey === row.candidateKey);
    const subject = row.trackName ? `${row.artistName} — ${row.trackName}` : row.artistName;
    console.log(
      `  ${String(index + 1).padStart(2)}. ${subject} — class=${row.historyClass}, depth=${candidate?.acquisitionDepth ?? 1}, score=${row.scoreCard.score}, sim=${row.similarity.toFixed(3)}, artistPlays=${row.artistHistoricalPlayCount}, trackPlays=${row.trackHistoricalPlayCount}, via=${candidate?.viaArtistName ?? "direct"}, root=${candidate?.rootSeedArtistName ?? row.seedArtistName}`,
    );
  });
  console.log("");
  console.log("No writes: no Spotify, MUSIC-03, preference, score persistence or planner changes.");
}

type EvaluationMetrics = {
  evaluatedCount: number;
  eligibleCount: number;
  newArtistCount: number;
  newTrackKnownArtistCount: number;
  knownTrackRejectedCount: number;
  knownArtistRejectedCount: number;
  uniqueArtistCount: number;
  knownShare: number;
  maxCandidatesForSingleArtist: number;
};

function evaluationMetrics(
  evaluated: EvaluatedExternalDiscoveryCandidate[],
  candidates: AcquiredExternalDiscoveryCandidate[],
): EvaluationMetrics {
  const artistCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const key = normalized(candidate.artistName);
    artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1);
  }
  const knownCount = evaluated.filter(
    (row) =>
      row.historyClass === "KNOWN_TRACK_NOT_NEW" || row.historyClass === "KNOWN_ARTIST_NOT_NEW",
  ).length;
  return {
    evaluatedCount: evaluated.length,
    eligibleCount: evaluated.filter((row) => row.scoreCard.eligible).length,
    newArtistCount: evaluated.filter((row) => row.historyClass === "NEW_ARTIST").length,
    newTrackKnownArtistCount: evaluated.filter(
      (row) => row.historyClass === "NEW_TRACK_KNOWN_ARTIST",
    ).length,
    knownTrackRejectedCount: evaluated.filter(
      (row) => row.historyClass === "KNOWN_TRACK_NOT_NEW",
    ).length,
    knownArtistRejectedCount: evaluated.filter(
      (row) => row.historyClass === "KNOWN_ARTIST_NOT_NEW",
    ).length,
    uniqueArtistCount: artistCounts.size,
    knownShare: evaluated.length === 0 ? 0 : Number((knownCount / evaluated.length).toFixed(4)),
    maxCandidatesForSingleArtist: Math.max(0, ...artistCounts.values()),
  };
}

function printMetrics(metrics: EvaluationMetrics): void {
  console.log(`Evaluated:                   ${metrics.evaluatedCount}`);
  console.log(`Eligible new:                ${metrics.eligibleCount}`);
  console.log(`NEW_ARTIST:                  ${metrics.newArtistCount}`);
  console.log(`NEW_TRACK_KNOWN_ARTIST:      ${metrics.newTrackKnownArtistCount}`);
  console.log(`KNOWN_TRACK_NOT_NEW:         ${metrics.knownTrackRejectedCount}`);
  console.log(`KNOWN_ARTIST_NOT_NEW:        ${metrics.knownArtistRejectedCount}`);
  console.log(`Unique candidate artists:    ${metrics.uniqueArtistCount}`);
  console.log(`Known-candidate share:       ${(metrics.knownShare * 100).toFixed(1)}%`);
  console.log(`Max candidates / one artist: ${metrics.maxCandidatesForSingleArtist}`);
}

type HistoryIndex = {
  byArtistName: Map<string, number>;
  byArtistMbid: Map<string, number>;
  byTrackMbid: Map<string, number>;
  byArtistTrackName: Map<string, number>;
};

async function getKnownHistory(
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
  const trackCandidates = candidates.filter(
    (row): row is AcquiredExternalDiscoveryCandidate & { trackName: string } =>
      row.candidateType === "TRACK" && Boolean(row.trackName),
  );
  const trackMbids = [
    ...new Set(
      trackCandidates
        .map((row) => row.trackMbid)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const trackArtistNames = [...new Set(trackCandidates.map((row) => row.artistName))];
  const trackNames = [...new Set(trackCandidates.map((row) => row.trackName))];

  const [artistNameRows, artistMbidRows, trackMbidRows, artistTrackRows] = await Promise.all([
    artistNames.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["artistName"],
          where: { userId, artistName: { in: artistNames, mode: "insensitive" } },
          _count: { _all: true },
        }),
    artistMbids.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["artistMbid"],
          where: { userId, artistMbid: { in: artistMbids } },
          _count: { _all: true },
        }),
    trackMbids.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["trackMbid"],
          where: { userId, trackMbid: { in: trackMbids } },
          _count: { _all: true },
        }),
    trackArtistNames.length === 0 || trackNames.length === 0
      ? Promise.resolve([])
      : prisma.trackListeningEvent.groupBy({
          by: ["artistName", "trackName"],
          where: {
            userId,
            artistName: { in: trackArtistNames, mode: "insensitive" },
            trackName: { in: trackNames, mode: "insensitive" },
          },
          _count: { _all: true },
        }),
  ]);

  const byArtistName = new Map<string, number>();
  for (const row of artistNameRows) {
    const key = normalized(row.artistName);
    byArtistName.set(key, (byArtistName.get(key) ?? 0) + row._count._all);
  }
  const byArtistMbid = new Map<string, number>();
  for (const row of artistMbidRows) {
    if (!row.artistMbid) continue;
    byArtistMbid.set(row.artistMbid, (byArtistMbid.get(row.artistMbid) ?? 0) + row._count._all);
  }
  const byTrackMbid = new Map<string, number>();
  for (const row of trackMbidRows) {
    if (!row.trackMbid) continue;
    byTrackMbid.set(row.trackMbid, (byTrackMbid.get(row.trackMbid) ?? 0) + row._count._all);
  }
  const byArtistTrackName = new Map<string, number>();
  for (const row of artistTrackRows) {
    const key = artistTrackKey(row.artistName, row.trackName);
    byArtistTrackName.set(key, (byArtistTrackName.get(key) ?? 0) + row._count._all);
  }
  return { byArtistName, byArtistMbid, byTrackMbid, byArtistTrackName };
}

function historyEvidenceFor(
  candidate: AcquiredExternalDiscoveryCandidate,
  history: HistoryIndex,
): ExternalDiscoveryHistoryEvidence {
  const artistByName = history.byArtistName.get(normalized(candidate.artistName)) ?? 0;
  const artistByMbid = candidate.artistMbid
    ? history.byArtistMbid.get(candidate.artistMbid) ?? 0
    : 0;
  const artistHistoricalPlayCount = Math.max(artistByName, artistByMbid);

  if (candidate.candidateType !== "TRACK" || !candidate.trackName) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: 0,
      trackHistoryMatch: "NOT_APPLICABLE",
    };
  }

  const trackByMbid = candidate.trackMbid
    ? history.byTrackMbid.get(candidate.trackMbid) ?? 0
    : 0;
  const trackByName =
    history.byArtistTrackName.get(artistTrackKey(candidate.artistName, candidate.trackName)) ?? 0;
  if (trackByMbid > 0) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: Math.max(trackByMbid, trackByName),
      trackHistoryMatch: "MBID",
    };
  }
  if (trackByName > 0) {
    return {
      artistHistoricalPlayCount,
      trackHistoricalPlayCount: trackByName,
      trackHistoryMatch: "ARTIST_TRACK_NAME",
    };
  }
  return {
    artistHistoricalPlayCount,
    trackHistoricalPlayCount: 0,
    trackHistoryMatch: "NONE",
  };
}

function artistTrackKey(artistName: string, trackName: string): string {
  return `${normalized(artistName)}\u0000${normalized(trackName)}`;
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
  let artistSeeds = 8;
  let trackSeeds = 8;
  let perSeed = 15;
  let bridgeSeeds = 5;
  let bridgePerSeed = 15;
  let topN = 30;
  let json = false;

  for (const arg of argv) {
    if (arg.startsWith("--email=")) email = arg.slice("--email=".length).trim();
    else if (arg.startsWith("--artist-seeds="))
      artistSeeds = boundedArg(arg, "--artist-seeds=", 1, 20);
    else if (arg.startsWith("--track-seeds="))
      trackSeeds = boundedArg(arg, "--track-seeds=", 0, 20);
    else if (arg.startsWith("--per-seed=")) perSeed = boundedArg(arg, "--per-seed=", 1, 100);
    else if (arg.startsWith("--bridge-seeds="))
      bridgeSeeds = boundedArg(arg, "--bridge-seeds=", 0, 10);
    else if (arg.startsWith("--bridge-per-seed="))
      bridgePerSeed = boundedArg(arg, "--bridge-per-seed=", 1, 100);
    else if (arg.startsWith("--top=")) topN = boundedArg(arg, "--top=", 1, 100);
    else if (arg === "--json") json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!email) throw new Error("--email=<Sonoriza user email> is required");
  return { email, artistSeeds, trackSeeds, perSeed, bridgeSeeds, bridgePerSeed, topN, json };
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
