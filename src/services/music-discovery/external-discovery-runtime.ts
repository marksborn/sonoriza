import { prisma } from "@/lib/prisma";
import { LastFmSimilarityClient } from "@/services/lastfm/similarity";
import { SpotifyCatalogSearchClient } from "@/services/spotify/catalog-search";
import type { Candidate } from "@/services/playlist-planner";

import {
  acquireLastFmExternalDiscovery,
  evaluateExternalDiscoveryCandidates,
  type AcquiredExternalDiscoveryCandidate,
  type ExternalDiscoveryArtistSeed,
  type ExternalDiscoveryHistoryEvidence,
  type ExternalDiscoveryTrackSeed,
} from "./external-discovery";
import {
  decorateRootCandidates,
  expandLastFmExternalDiscoverySecondHop,
  mergeDiversifiedExternalDiscoveryCandidates,
  selectArtistDiverseTracks,
  selectDiversifiedArtistSeeds,
} from "./external-discovery-diversity";
import { arbitrateExternalDiscoveryPaths } from "./external-discovery-arbitration";
import type { Gate5FResolvedDiscoveryCandidate } from "./planner-discovery-gate5f";
import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
} from "./profile";
import { buildDiscoveryGate22ScoringReport } from "./scoring-gate2-2";
import {
  resolveExternalDiscoveryCandidates,
  type SpotifyDiscoveryResolutionCandidate,
} from "./spotify-resolution";
import { getDiscoveryTrackIdentityEvidence } from "./track-identity";

const PROFILE_POOL_SIZE = 100;

export const DISCOVERY_GATE5H_ACQUISITION_POLICY = {
  artistSeeds: 8,
  trackSeeds: 8,
  perSeed: 15,
  bridgeSeeds: 5,
  bridgePerSeed: 15,
  topN: 30,
  maxPerPath: 2,
  maxPerRoot: 3,
  maxPerBridge: 2,
  repeatPenaltyPerSelection: 0.07,
  minimumAdjustedScore: 55,
} as const;

export type RuntimeExternalDiscoveryEvidence = {
  lastFmCalls: number;
  lastFmFailures: number;
  combinedCandidateCount: number;
  eligibleBeforeArbitration: number;
  selectedAfterArbitration: number;
  spotifyCatalogCalls: number;
  spotifyFailures: number;
  spotifyRateLimits: number;
  spotifyRetries: number;
  resolvedCount: number;
  ambiguousCount: number;
  notFoundCount: number;
  providerFailureCount: number;
};

export type RuntimeExternalDiscoveryResult = {
  discoveries: Gate5FResolvedDiscoveryCandidate[];
  evidence: RuntimeExternalDiscoveryEvidence;
};

type HistoryIndex = {
  byArtistName: Map<string, number>;
  byArtistMbid: Map<string, number>;
  byTrackMbid: Map<string, number>;
  byArtistTrackName: Map<string, number>;
};

export async function resolveRuntimeExternalDiscovery(input: {
  userId: string;
  asOf: Date;
}): Promise<RuntimeExternalDiscoveryResult> {
  const apiKey = process.env.LASTFM_API_KEY?.trim();
  if (!apiKey) throw new Error("LASTFM_API_KEY is required for DISCOVERY Gate 5H");

  const [profile, trackIdentities] = await Promise.all([
    getMusicDiscoveryProfile(input.userId, {
      asOf: input.asOf,
      topN: PROFILE_POOL_SIZE,
    }),
    getDiscoveryTrackIdentityEvidence(input.userId),
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
      [...profile.rediscoveryReturns, ...profile.dormantFavorites].map(
        (row) => row.artistName,
      ),
    ],
    limit: DISCOVERY_GATE5H_ACQUISITION_POLICY.artistSeeds,
  });

  const artistAffinityByName = new Map(
    affinityRows.map((row) => [normalized(row.artistName), row.affinity] as const),
  );
  const trackSeedCandidates = selectArtistDiverseTracks(
    [...scoring.familiarCandidates, ...scoring.rediscoveryCandidates],
    DISCOVERY_GATE5H_ACQUISITION_POLICY.trackSeeds,
  );
  const trackSeeds: ExternalDiscoveryTrackSeed[] = trackSeedCandidates.map((row) => ({
    artistName: row.artistName,
    trackName: row.trackName,
    artistAffinity:
      artistAffinityByName.get(normalized(row.artistName)) ?? row.score / 100,
    trackAffinity: row.score / 100,
  }));

  const provider = new LastFmSimilarityClient({ apiKey });
  const rootAcquisition = await acquireLastFmExternalDiscovery({
    provider,
    artistSeeds,
    trackSeeds,
    perSeed: DISCOVERY_GATE5H_ACQUISITION_POLICY.perSeed,
    maxCandidates: Math.max(DISCOVERY_GATE5H_ACQUISITION_POLICY.topN * 6, 100),
  });
  const rootHistory = await getKnownHistory(input.userId, rootAcquisition.candidates);
  const rootEvaluation = evaluateExternalDiscoveryCandidates({
    candidates: rootAcquisition.candidates,
    historyEvidence: (candidate) => historyEvidenceFor(candidate, rootHistory),
    topN: DISCOVERY_GATE5H_ACQUISITION_POLICY.topN,
  });

  const rootDecorated = decorateRootCandidates(rootAcquisition.candidates);
  const knownArtistCandidateKeys = new Set(
    rootEvaluation.evaluated
      .filter(
        (row) =>
          row.candidateType === "ARTIST" &&
          row.historyClass === "KNOWN_ARTIST_NOT_NEW",
      )
      .map((row) => row.candidateKey),
  );
  const originalSeedArtists = new Set(
    artistSeeds.map((row) => normalized(row.artistName)),
  );
  const bridges = rootDecorated
    .filter(
      (row) =>
        row.candidateType === "ARTIST" &&
        knownArtistCandidateKeys.has(row.candidateKey) &&
        !originalSeedArtists.has(normalized(row.artistName)),
    )
    .slice(0, DISCOVERY_GATE5H_ACQUISITION_POLICY.bridgeSeeds);

  const expansion = await expandLastFmExternalDiscoverySecondHop({
    provider,
    bridges,
    perSeed: DISCOVERY_GATE5H_ACQUISITION_POLICY.bridgePerSeed,
    maxCandidates: Math.max(DISCOVERY_GATE5H_ACQUISITION_POLICY.topN * 6, 100),
  });
  const combinedCandidates = mergeDiversifiedExternalDiscoveryCandidates({
    root: rootDecorated,
    expanded: expansion.candidates,
    maxCandidates: Math.max(DISCOVERY_GATE5H_ACQUISITION_POLICY.topN * 10, 150),
  });
  const combinedHistory = await getKnownHistory(input.userId, combinedCandidates);
  const combinedEvaluation = evaluateExternalDiscoveryCandidates({
    candidates: combinedCandidates,
    historyEvidence: (candidate) => historyEvidenceFor(candidate, combinedHistory),
    topN: DISCOVERY_GATE5H_ACQUISITION_POLICY.topN,
  });

  const candidateByKey = new Map(
    combinedCandidates.map((row) => [row.candidateKey, row] as const),
  );
  const eligible = combinedEvaluation.eligible.map((row) => {
    const source = candidateByKey.get(row.candidateKey);
    return {
      ...row,
      acquisitionDepth: source?.acquisitionDepth ?? 1,
      viaArtistName: source?.viaArtistName ?? null,
      rootSeedArtistName: source?.rootSeedArtistName ?? row.seedArtistName,
    };
  });
  const arbitration = arbitrateExternalDiscoveryPaths({
    candidates: eligible,
    topN: DISCOVERY_GATE5H_ACQUISITION_POLICY.topN,
    maxPerPath: DISCOVERY_GATE5H_ACQUISITION_POLICY.maxPerPath,
    maxPerRoot: DISCOVERY_GATE5H_ACQUISITION_POLICY.maxPerRoot,
    maxPerBridge: DISCOVERY_GATE5H_ACQUISITION_POLICY.maxPerBridge,
    repeatPenaltyPerSelection:
      DISCOVERY_GATE5H_ACQUISITION_POLICY.repeatPenaltyPerSelection,
    minimumAdjustedScore:
      DISCOVERY_GATE5H_ACQUISITION_POLICY.minimumAdjustedScore,
  });

  const spotify = await SpotifyCatalogSearchClient.forUser(input.userId);
  const batch = await resolveExternalDiscoveryCandidates(
    spotify,
    arbitration.selected as SpotifyDiscoveryResolutionCandidate[],
  );
  const spotifyMetrics = spotify.getMetrics();
  const selectedByKey = new Map(
    arbitration.selected.map((row) => [row.candidateKey, row] as const),
  );
  const discoveries: Gate5FResolvedDiscoveryCandidate[] = [];
  let ambiguousCount = 0;
  let notFoundCount = 0;

  for (const resolution of batch.resolutions) {
    if (resolution.status === "AMBIGUOUS") {
      ambiguousCount += 1;
      continue;
    }
    if (resolution.status === "NOT_FOUND") {
      notFoundCount += 1;
      continue;
    }
    if (!resolution.spotifyArtist || !resolution.spotifyTrack) continue;
    const source = selectedByKey.get(resolution.candidateKey);
    if (!source) continue;
    const track = resolution.spotifyTrack;
    const artist = resolution.spotifyArtist;
    const candidate: Candidate = {
      uri: track.uri,
      type: "MUSIC",
      title: track.name,
      subtitle: artist.name,
      spotifyTrackId: track.id,
      primaryArtistId: artist.id,
      primaryArtistName: artist.name,
      ...(track.albumId ? { albumId: track.albumId } : {}),
      ...(track.albumName ? { albumName: track.albumName } : {}),
      durationMs: track.durationMs,
    };
    discoveries.push({
      candidateKey: source.candidateKey,
      candidate,
      rawScore: source.scoreCard.score,
      adjustedScore: source.arbitrationAdjustedScore,
      historyClass: source.historyClass,
      pathLabel: source.pathLabel,
      resolutionReason: resolution.reason,
      isrc: track.isrc,
    });
  }

  return {
    discoveries,
    evidence: {
      lastFmCalls: rootAcquisition.providerCalls + expansion.providerCalls,
      lastFmFailures: rootAcquisition.failures.length + expansion.failures.length,
      combinedCandidateCount: combinedCandidates.length,
      eligibleBeforeArbitration: combinedEvaluation.eligible.length,
      selectedAfterArbitration: arbitration.selected.length,
      spotifyCatalogCalls: spotifyMetrics.totalCalls,
      spotifyFailures: spotifyMetrics.failures,
      spotifyRateLimits: spotifyMetrics.rateLimitedCount,
      spotifyRetries: spotifyMetrics.retries,
      resolvedCount: discoveries.length,
      ambiguousCount,
      notFoundCount,
      providerFailureCount: batch.failures.length,
    },
  };
}

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

  const [artistNameRows, artistMbidRows, trackMbidRows, artistTrackRows] =
    await Promise.all([
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
              artistName: {
                in: trackArtistNames,
                mode: "insensitive",
              },
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
    byArtistMbid.set(
      row.artistMbid,
      (byArtistMbid.get(row.artistMbid) ?? 0) + row._count._all,
    );
  }
  const byTrackMbid = new Map<string, number>();
  for (const row of trackMbidRows) {
    if (!row.trackMbid) continue;
    byTrackMbid.set(
      row.trackMbid,
      (byTrackMbid.get(row.trackMbid) ?? 0) + row._count._all,
    );
  }
  const byArtistTrackName = new Map<string, number>();
  for (const row of artistTrackRows) {
    const key = artistTrackKey(row.artistName, row.trackName);
    byArtistTrackName.set(
      key,
      (byArtistTrackName.get(key) ?? 0) + row._count._all,
    );
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
    history.byArtistTrackName.get(
      artistTrackKey(candidate.artistName, candidate.trackName),
    ) ?? 0;
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

function artistTrackKey(artistName: string, trackName: string): string {
  return `${normalized(artistName)}\u0000${normalized(trackName)}`;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}
