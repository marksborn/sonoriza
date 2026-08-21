import type {
  LastFmSimilarArtist,
  LastFmSimilarTrack,
} from "../lastfm/similarity";
import {
  scoreExternalDiscoveryCandidate,
  type DiscoveryCandidateProvenance,
  type ExternalDiscoveryCandidateScore,
} from "./scoring";

export type ExternalDiscoveryArtistSeed = {
  artistName: string;
  artistMbid?: string | null;
  affinity: number;
};

export type ExternalDiscoveryTrackSeed = {
  artistName: string;
  trackName: string;
  trackMbid?: string | null;
  artistAffinity: number;
  trackAffinity: number;
};

export type ExternalDiscoverySimilarityProvider = {
  getSimilarArtists(input: {
    artistName: string;
    artistMbid?: string | null;
    limit?: number;
  }): Promise<LastFmSimilarArtist[]>;
  getSimilarTracks(input: {
    artistName: string;
    trackName: string;
    trackMbid?: string | null;
    limit?: number;
  }): Promise<LastFmSimilarTrack[]>;
};

export type AcquiredExternalDiscoveryCandidate = {
  candidateKey: string;
  candidateType: "ARTIST" | "TRACK";
  artistName: string;
  trackName: string | null;
  artistMbid: string | null;
  trackMbid: string | null;
  source: Extract<
    DiscoveryCandidateProvenance,
    "LASTFM_SIMILAR_ARTIST" | "LASTFM_SIMILAR_TRACK"
  >;
  similarity: number;
  sourceConfidence: number;
  seedArtistName: string;
  seedTrackName: string | null;
  seedArtistAffinity: number;
  seedTrackAffinity: number | null;
};

export type ExternalDiscoveryAcquisitionFailure = {
  source: "LASTFM_SIMILAR_ARTIST" | "LASTFM_SIMILAR_TRACK";
  seedArtistName: string;
  seedTrackName: string | null;
  error: string;
};

export type ExternalDiscoveryAcquisitionResult = {
  status: "READY" | "ABSTAINED";
  abstentionReason: "NO_CANDIDATES" | "PROVIDER_ERRORS" | null;
  providerCalls: number;
  candidates: AcquiredExternalDiscoveryCandidate[];
  failures: ExternalDiscoveryAcquisitionFailure[];
};

export type EvaluatedExternalDiscoveryCandidate = AcquiredExternalDiscoveryCandidate & {
  knownHistoricalPlayCount: number;
  scoreCard: ExternalDiscoveryCandidateScore;
};

export type ExternalDiscoveryEvaluationResult = {
  evaluated: EvaluatedExternalDiscoveryCandidate[];
  eligible: EvaluatedExternalDiscoveryCandidate[];
};

export async function acquireLastFmExternalDiscovery(input: {
  provider: ExternalDiscoverySimilarityProvider;
  artistSeeds: ExternalDiscoveryArtistSeed[];
  trackSeeds: ExternalDiscoveryTrackSeed[];
  perSeed?: number;
  maxCandidates?: number;
}): Promise<ExternalDiscoveryAcquisitionResult> {
  const perSeed = boundedPositiveInt(input.perSeed ?? 10, "perSeed", 100);
  const maxCandidates = boundedPositiveInt(
    input.maxCandidates ?? 100,
    "maxCandidates",
    500,
  );
  const candidates = new Map<string, AcquiredExternalDiscoveryCandidate>();
  const failures: ExternalDiscoveryAcquisitionFailure[] = [];
  let providerCalls = 0;

  for (const seed of input.artistSeeds) {
    validateUnit(seed.affinity, "artist seed affinity");
    providerCalls += 1;
    try {
      const similar = await input.provider.getSimilarArtists({
        artistName: seed.artistName,
        artistMbid: seed.artistMbid,
        limit: perSeed,
      });
      for (const candidate of similar) {
        if (normalized(candidate.name) === normalized(seed.artistName)) continue;
        keepBestCandidate(
          candidates,
          fromSimilarArtist(candidate, seed),
        );
      }
    } catch (error) {
      failures.push({
        source: "LASTFM_SIMILAR_ARTIST",
        seedArtistName: seed.artistName,
        seedTrackName: null,
        error: errorMessage(error),
      });
    }
  }

  for (const seed of input.trackSeeds) {
    validateUnit(seed.artistAffinity, "track seed artist affinity");
    validateUnit(seed.trackAffinity, "track seed affinity");
    providerCalls += 1;
    try {
      const similar = await input.provider.getSimilarTracks({
        artistName: seed.artistName,
        trackName: seed.trackName,
        trackMbid: seed.trackMbid,
        limit: perSeed,
      });
      for (const candidate of similar) {
        if (
          normalized(candidate.artistName) === normalized(seed.artistName) &&
          normalized(candidate.name) === normalized(seed.trackName)
        ) {
          continue;
        }
        keepBestCandidate(candidates, fromSimilarTrack(candidate, seed));
      }
    } catch (error) {
      failures.push({
        source: "LASTFM_SIMILAR_TRACK",
        seedArtistName: seed.artistName,
        seedTrackName: seed.trackName,
        error: errorMessage(error),
      });
    }
  }

  const ranked = [...candidates.values()]
    .sort((left, right) => acquisitionPotential(right) - acquisitionPotential(left))
    .slice(0, maxCandidates);

  if (ranked.length > 0) {
    return {
      status: "READY",
      abstentionReason: null,
      providerCalls,
      candidates: ranked,
      failures,
    };
  }

  return {
    status: "ABSTAINED",
    abstentionReason: failures.length > 0 ? "PROVIDER_ERRORS" : "NO_CANDIDATES",
    providerCalls,
    candidates: [],
    failures,
  };
}

export function evaluateExternalDiscoveryCandidates(input: {
  candidates: AcquiredExternalDiscoveryCandidate[];
  knownHistoricalPlayCount: (
    candidate: AcquiredExternalDiscoveryCandidate,
  ) => number;
  topN?: number;
}): ExternalDiscoveryEvaluationResult {
  const topN = boundedPositiveInt(input.topN ?? 50, "topN", 500);
  const evaluated = input.candidates.map((candidate) => {
    const knownHistoricalPlayCount = input.knownHistoricalPlayCount(candidate);
    if (!Number.isInteger(knownHistoricalPlayCount) || knownHistoricalPlayCount < 0) {
      throw new Error("knownHistoricalPlayCount must return a non-negative integer");
    }
    const scoreCard = scoreExternalDiscoveryCandidate({
      candidateKey: candidate.candidateKey,
      artistName: candidate.artistName,
      source: candidate.source,
      similarity: candidate.similarity,
      seedArtistAffinity: candidate.seedArtistAffinity,
      seedTrackAffinity: candidate.seedTrackAffinity,
      sourceConfidence: candidate.sourceConfidence,
      knownHistoricalPlayCount,
    });
    return {
      ...candidate,
      knownHistoricalPlayCount,
      scoreCard,
    };
  });

  evaluated.sort((left, right) => {
    if (left.scoreCard.eligible !== right.scoreCard.eligible) {
      return left.scoreCard.eligible ? -1 : 1;
    }
    return right.scoreCard.score - left.scoreCard.score;
  });

  return {
    evaluated,
    eligible: evaluated.filter((row) => row.scoreCard.eligible).slice(0, topN),
  };
}

function fromSimilarArtist(
  candidate: LastFmSimilarArtist,
  seed: ExternalDiscoveryArtistSeed,
): AcquiredExternalDiscoveryCandidate {
  return {
    candidateKey: candidate.artistMbid
      ? `artist:mbid:${candidate.artistMbid}`
      : `artist:name:${normalized(candidate.name)}`,
    candidateType: "ARTIST",
    artistName: candidate.name,
    trackName: null,
    artistMbid: candidate.mbid,
    trackMbid: null,
    source: "LASTFM_SIMILAR_ARTIST",
    similarity: candidate.match,
    sourceConfidence: 0.9,
    seedArtistName: seed.artistName,
    seedTrackName: null,
    seedArtistAffinity: seed.affinity,
    seedTrackAffinity: null,
  };
}

function fromSimilarTrack(
  candidate: LastFmSimilarTrack,
  seed: ExternalDiscoveryTrackSeed,
): AcquiredExternalDiscoveryCandidate {
  return {
    candidateKey: candidate.trackMbid
      ? `track:mbid:${candidate.trackMbid}`
      : `track:name:${normalized(candidate.artistName)}\u0000${normalized(candidate.name)}`,
    candidateType: "TRACK",
    artistName: candidate.artistName,
    trackName: candidate.name,
    artistMbid: candidate.artistMbid,
    trackMbid: candidate.trackMbid,
    source: "LASTFM_SIMILAR_TRACK",
    similarity: candidate.match,
    sourceConfidence: 0.85,
    seedArtistName: seed.artistName,
    seedTrackName: seed.trackName,
    seedArtistAffinity: seed.artistAffinity,
    seedTrackAffinity: seed.trackAffinity,
  };
}

function keepBestCandidate(
  byKey: Map<string, AcquiredExternalDiscoveryCandidate>,
  candidate: AcquiredExternalDiscoveryCandidate,
): void {
  const current = byKey.get(candidate.candidateKey);
  if (!current || acquisitionPotential(candidate) > acquisitionPotential(current)) {
    byKey.set(candidate.candidateKey, candidate);
  }
}

function acquisitionPotential(candidate: AcquiredExternalDiscoveryCandidate): number {
  const seedTrackAffinity = candidate.seedTrackAffinity ?? candidate.seedArtistAffinity;
  return (
    candidate.similarity * 0.6 +
    candidate.seedArtistAffinity * 0.3 +
    seedTrackAffinity * 0.1
  );
}

function validateUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function boundedPositiveInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
