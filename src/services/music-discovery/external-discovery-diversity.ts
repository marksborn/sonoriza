import type { LastFmSimilarArtist } from "../lastfm/similarity";
import {
  type AcquiredExternalDiscoveryCandidate,
  type ExternalDiscoveryAcquisitionFailure,
  type ExternalDiscoverySimilarityProvider,
} from "./external-discovery";

export type DiversifiedExternalDiscoveryCandidate = AcquiredExternalDiscoveryCandidate & {
  acquisitionDepth: 1 | 2;
  rootSeedArtistName: string;
  rootSeedTrackName: string | null;
  viaArtistName: string | null;
};

export type ExternalDiscoverySecondHopResult = {
  status: "READY" | "ABSTAINED";
  abstentionReason: "NO_BRIDGES" | "NO_CANDIDATES" | "PROVIDER_ERRORS" | null;
  providerCalls: number;
  bridgeCount: number;
  candidates: DiversifiedExternalDiscoveryCandidate[];
  failures: ExternalDiscoveryAcquisitionFailure[];
};

export function decorateRootCandidates(
  candidates: AcquiredExternalDiscoveryCandidate[],
): DiversifiedExternalDiscoveryCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    acquisitionDepth: 1,
    rootSeedArtistName: candidate.seedArtistName,
    rootSeedTrackName: candidate.seedTrackName,
    viaArtistName: null,
  }));
}

export function selectDiversifiedArtistSeeds(input: {
  affinity: Array<{ artistName: string; affinity: number }>;
  priorityBuckets: string[][];
  limit: number;
}): Array<{ artistName: string; affinity: number }> {
  const limit = boundedNonNegativeInt(input.limit, "limit", 50);
  if (limit === 0) return [];

  const affinityByName = new Map(
    input.affinity.map((row) => [normalized(row.artistName), row] as const),
  );
  const selected: Array<{ artistName: string; affinity: number }> = [];
  const seen = new Set<string>();
  const offsets = input.priorityBuckets.map(() => 0);

  while (selected.length < limit) {
    let progressed = false;
    for (let bucketIndex = 0; bucketIndex < input.priorityBuckets.length; bucketIndex += 1) {
      const bucket = input.priorityBuckets[bucketIndex] ?? [];
      while ((offsets[bucketIndex] ?? 0) < bucket.length) {
        const offset = offsets[bucketIndex] ?? 0;
        const artistName = bucket[offset]!;
        offsets[bucketIndex] = offset + 1;
        const key = normalized(artistName);
        if (seen.has(key)) continue;
        const affinity = affinityByName.get(key);
        if (!affinity) continue;
        validateUnit(affinity.affinity, "artist affinity");
        selected.push(affinity);
        seen.add(key);
        progressed = true;
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }

  for (const row of input.affinity) {
    if (selected.length >= limit) break;
    const key = normalized(row.artistName);
    if (seen.has(key)) continue;
    validateUnit(row.affinity, "artist affinity");
    selected.push(row);
    seen.add(key);
  }

  return selected;
}

export function selectArtistDiverseTracks<T extends {
  artistName: string;
  spotifyTrackId: string;
  score: number;
}>(rows: T[], limit: number): T[] {
  const boundedLimit = boundedNonNegativeInt(limit, "limit", 100);
  if (boundedLimit === 0) return [];

  const bestByTrack = new Map<string, T>();
  for (const row of rows) {
    const current = bestByTrack.get(row.spotifyTrackId);
    if (!current || row.score > current.score) bestByTrack.set(row.spotifyTrackId, row);
  }
  const ranked = [...bestByTrack.values()].sort((left, right) => right.score - left.score);
  const selected: T[] = [];
  const selectedTrackIds = new Set<string>();
  const seenArtists = new Set<string>();

  for (const row of ranked) {
    if (selected.length >= boundedLimit) break;
    const artistKey = normalized(row.artistName);
    if (seenArtists.has(artistKey)) continue;
    selected.push(row);
    selectedTrackIds.add(row.spotifyTrackId);
    seenArtists.add(artistKey);
  }

  for (const row of ranked) {
    if (selected.length >= boundedLimit) break;
    if (selectedTrackIds.has(row.spotifyTrackId)) continue;
    selected.push(row);
    selectedTrackIds.add(row.spotifyTrackId);
  }

  return selected;
}

export async function expandLastFmExternalDiscoverySecondHop(input: {
  provider: ExternalDiscoverySimilarityProvider;
  bridges: DiversifiedExternalDiscoveryCandidate[];
  perSeed?: number;
  maxCandidates?: number;
}): Promise<ExternalDiscoverySecondHopResult> {
  const perSeed = boundedPositiveInt(input.perSeed ?? 10, "perSeed", 100);
  const maxCandidates = boundedPositiveInt(input.maxCandidates ?? 100, "maxCandidates", 500);
  const bridges = dedupeBridges(input.bridges).filter((row) => row.candidateType === "ARTIST");

  if (bridges.length === 0) {
    return {
      status: "ABSTAINED",
      abstentionReason: "NO_BRIDGES",
      providerCalls: 0,
      bridgeCount: 0,
      candidates: [],
      failures: [],
    };
  }

  const candidates = new Map<string, DiversifiedExternalDiscoveryCandidate>();
  const failures: ExternalDiscoveryAcquisitionFailure[] = [];
  let providerCalls = 0;

  for (const bridge of bridges) {
    providerCalls += 1;
    try {
      const similar = await input.provider.getSimilarArtists({
        artistName: bridge.artistName,
        artistMbid: bridge.artistMbid,
        limit: perSeed,
      });
      for (const candidate of similar) {
        if (shouldSkipSecondHopCandidate(candidate, bridge)) continue;
        const expanded = fromSecondHopArtist(candidate, bridge);
        keepBestCandidate(candidates, expanded);
      }
    } catch (error) {
      failures.push({
        source: "LASTFM_SIMILAR_ARTIST",
        seedArtistName: bridge.artistName,
        seedTrackName: null,
        error: errorMessage(error),
      });
    }
  }

  const ranked = [...candidates.values()]
    .sort((left, right) => candidatePotential(right) - candidatePotential(left))
    .slice(0, maxCandidates);

  if (ranked.length > 0) {
    return {
      status: "READY",
      abstentionReason: null,
      providerCalls,
      bridgeCount: bridges.length,
      candidates: ranked,
      failures,
    };
  }

  return {
    status: "ABSTAINED",
    abstentionReason: failures.length > 0 ? "PROVIDER_ERRORS" : "NO_CANDIDATES",
    providerCalls,
    bridgeCount: bridges.length,
    candidates: [],
    failures,
  };
}

export function mergeDiversifiedExternalDiscoveryCandidates(input: {
  root: DiversifiedExternalDiscoveryCandidate[];
  expanded: DiversifiedExternalDiscoveryCandidate[];
  maxCandidates?: number;
}): DiversifiedExternalDiscoveryCandidate[] {
  const maxCandidates = boundedPositiveInt(input.maxCandidates ?? 300, "maxCandidates", 500);
  const byKey = new Map<string, DiversifiedExternalDiscoveryCandidate>();

  for (const candidate of input.root) byKey.set(candidate.candidateKey, candidate);
  for (const candidate of input.expanded) {
    const current = byKey.get(candidate.candidateKey);
    if (!current) {
      byKey.set(candidate.candidateKey, candidate);
      continue;
    }
    if (current.acquisitionDepth === 1) continue;
    if (candidatePotential(candidate) > candidatePotential(current)) {
      byKey.set(candidate.candidateKey, candidate);
    }
  }

  return [...byKey.values()]
    .sort((left, right) => candidatePotential(right) - candidatePotential(left))
    .slice(0, maxCandidates);
}

function dedupeBridges(
  bridges: DiversifiedExternalDiscoveryCandidate[],
): DiversifiedExternalDiscoveryCandidate[] {
  const byArtist = new Map<string, DiversifiedExternalDiscoveryCandidate>();
  for (const bridge of bridges) {
    const key = bridge.artistMbid ? `mbid:${bridge.artistMbid}` : `name:${normalized(bridge.artistName)}`;
    const current = byArtist.get(key);
    if (!current || candidatePotential(bridge) > candidatePotential(current)) {
      byArtist.set(key, bridge);
    }
  }
  return [...byArtist.values()];
}

function shouldSkipSecondHopCandidate(
  candidate: LastFmSimilarArtist,
  bridge: DiversifiedExternalDiscoveryCandidate,
): boolean {
  const candidateName = normalized(candidate.name);
  return (
    candidateName === normalized(bridge.artistName) ||
    candidateName === normalized(bridge.rootSeedArtistName)
  );
}

function fromSecondHopArtist(
  candidate: LastFmSimilarArtist,
  bridge: DiversifiedExternalDiscoveryCandidate,
): DiversifiedExternalDiscoveryCandidate {
  const pathSimilarity = clamp01(bridge.similarity * candidate.match);
  const inheritedAffinity = clamp01(bridge.seedArtistAffinity * bridge.similarity);
  return {
    candidateKey: candidate.mbid
      ? `artist:mbid:${candidate.mbid}`
      : `artist:name:${normalized(candidate.name)}`,
    candidateType: "ARTIST",
    artistName: candidate.name,
    trackName: null,
    artistMbid: candidate.mbid,
    trackMbid: null,
    source: "LASTFM_SIMILAR_ARTIST",
    similarity: pathSimilarity,
    sourceConfidence: 0.72,
    seedArtistName: bridge.artistName,
    seedTrackName: null,
    seedArtistAffinity: inheritedAffinity,
    seedTrackAffinity: inheritedAffinity,
    acquisitionDepth: 2,
    rootSeedArtistName: bridge.rootSeedArtistName,
    rootSeedTrackName: bridge.rootSeedTrackName,
    viaArtistName: bridge.artistName,
  };
}

function keepBestCandidate(
  byKey: Map<string, DiversifiedExternalDiscoveryCandidate>,
  candidate: DiversifiedExternalDiscoveryCandidate,
): void {
  const current = byKey.get(candidate.candidateKey);
  if (!current || candidatePotential(candidate) > candidatePotential(current)) {
    byKey.set(candidate.candidateKey, candidate);
  }
}

function candidatePotential(candidate: AcquiredExternalDiscoveryCandidate): number {
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

function boundedNonNegativeInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
