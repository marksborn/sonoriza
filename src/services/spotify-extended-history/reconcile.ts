import type { SpotifyExtendedMusicEvent } from "./parser";

export const CONFIDENT_MATCH_TOLERANCE_MS = 2 * 60 * 1000;
export const AMBIGUOUS_MATCH_TOLERANCE_MS = 10 * 60 * 1000;

export type ExistingListeningEvent = {
  id: string;
  spotifyTrackId: string | null;
  trackName: string;
  artistName: string;
  playedAt: Date;
  source: string;
  sourceEventKey?: string | null;
  metadata: unknown;
};

export type SpotifyExtendedClassification =
  | "EXACT_EXISTING_LASTFM"
  | "EXACT_EXISTING_RECENTLY_PLAYED"
  | "EXACT_EXISTING_EXTENDED_HISTORY"
  | "NEW_UNCOVERED_EVENT"
  | "CONFLICT_AMBIGUOUS";

export type SpotifyExtendedConflictReason =
  | "MULTIPLE_CONFIDENT_LASTFM"
  | "MULTIPLE_CONFIDENT_SPOTIFY"
  | "CONFIDENT_CROSS_SOURCE"
  | "NEAR_ONLY_LASTFM"
  | "NEAR_ONLY_SPOTIFY"
  | "NEAR_CROSS_SOURCE";

export type ReconciledSpotifyExtendedEvent = {
  event: SpotifyExtendedMusicEvent;
  classification: SpotifyExtendedClassification;
  matchedExistingEventId: string | null;
  matchedSource: string | null;
  matchDeltaMs: number | null;
  enrichmentCandidate: boolean;
  candidateCount: number;
  conflictReason: SpotifyExtendedConflictReason | null;
  nearestCandidateDeltaMs: number | null;
};

export type SpotifyExtendedReconciliationSummary = {
  totalUniqueExportEvents: number;
  exactExistingLastFm: number;
  exactExistingRecentlyPlayed: number;
  exactExistingExtendedHistory: number;
  newUncoveredEvents: number;
  conflictAmbiguous: number;
  enrichmentCandidates: number;
  estimatedInserts: number;
  lastFmMatchDeltaMs: number[];
  recentlyPlayedMatchDeltaMs: number[];
  conflictReasonCounts: Record<SpotifyExtendedConflictReason, number>;
  conflictCandidateCountBuckets: {
    one: number;
    two: number;
    three: number;
    four: number;
    fiveOrMore: number;
  };
  conflictNearestDeltaMs: number[];
};

export type SpotifyExtendedReconciliation = {
  entries: ReconciledSpotifyExtendedEvent[];
  summary: SpotifyExtendedReconciliationSummary;
};

type IndexedExistingEvent = ExistingListeningEvent & { playedAtMs: number };
type Candidate = { event: IndexedExistingEvent; deltaMs: number };

export function reconcileSpotifyExtendedHistory(
  exportEvents: SpotifyExtendedMusicEvent[],
  existingEvents: ExistingListeningEvent[],
): SpotifyExtendedReconciliation {
  const extendedSourceKeyIndex = new Map<string, IndexedExistingEvent>();
  const spotifyIndex = new Map<string, IndexedExistingEvent[]>();
  const lastFmNameIndex = new Map<string, IndexedExistingEvent[]>();

  for (const existing of existingEvents) {
    const indexed: IndexedExistingEvent = { ...existing, playedAtMs: existing.playedAt.getTime() };

    if (existing.source === "SPOTIFY_EXTENDED_HISTORY" && existing.sourceEventKey) {
      extendedSourceKeyIndex.set(existing.sourceEventKey, indexed);
      continue;
    }

    if (existing.source === "SPOTIFY_RECENTLY_PLAYED" && existing.spotifyTrackId) {
      pushIndex(spotifyIndex, existing.spotifyTrackId, indexed);
    }

    if (existing.source === "LASTFM_SCROBBLE") {
      pushIndex(lastFmNameIndex, artistTrackKey(existing.artistName, existing.trackName), indexed);
    }
  }

  sortIndex(spotifyIndex);
  sortIndex(lastFmNameIndex);

  const entries = exportEvents.map((event) =>
    reconcileOne(event, extendedSourceKeyIndex, spotifyIndex, lastFmNameIndex),
  );

  const summary: SpotifyExtendedReconciliationSummary = {
    totalUniqueExportEvents: entries.length,
    exactExistingLastFm: 0,
    exactExistingRecentlyPlayed: 0,
    exactExistingExtendedHistory: 0,
    newUncoveredEvents: 0,
    conflictAmbiguous: 0,
    enrichmentCandidates: 0,
    estimatedInserts: 0,
    lastFmMatchDeltaMs: [],
    recentlyPlayedMatchDeltaMs: [],
    conflictReasonCounts: emptyConflictReasonCounts(),
    conflictCandidateCountBuckets: {
      one: 0,
      two: 0,
      three: 0,
      four: 0,
      fiveOrMore: 0,
    },
    conflictNearestDeltaMs: [],
  };

  for (const entry of entries) {
    if (entry.classification === "EXACT_EXISTING_LASTFM") {
      summary.exactExistingLastFm += 1;
      if (entry.matchDeltaMs !== null) summary.lastFmMatchDeltaMs.push(entry.matchDeltaMs);
    } else if (entry.classification === "EXACT_EXISTING_RECENTLY_PLAYED") {
      summary.exactExistingRecentlyPlayed += 1;
      if (entry.matchDeltaMs !== null) summary.recentlyPlayedMatchDeltaMs.push(entry.matchDeltaMs);
    } else if (entry.classification === "EXACT_EXISTING_EXTENDED_HISTORY") {
      summary.exactExistingExtendedHistory += 1;
    } else if (entry.classification === "NEW_UNCOVERED_EVENT") {
      summary.newUncoveredEvents += 1;
      summary.estimatedInserts += 1;
    } else {
      summary.conflictAmbiguous += 1;
      if (entry.conflictReason) summary.conflictReasonCounts[entry.conflictReason] += 1;
      incrementCandidateBucket(summary.conflictCandidateCountBuckets, entry.candidateCount);
      if (entry.nearestCandidateDeltaMs !== null) {
        summary.conflictNearestDeltaMs.push(entry.nearestCandidateDeltaMs);
      }
    }

    if (entry.enrichmentCandidate) summary.enrichmentCandidates += 1;
  }

  return { entries, summary };
}

function reconcileOne(
  event: SpotifyExtendedMusicEvent,
  extendedSourceKeyIndex: Map<string, IndexedExistingEvent>,
  spotifyIndex: Map<string, IndexedExistingEvent[]>,
  lastFmNameIndex: Map<string, IndexedExistingEvent[]>,
): ReconciledSpotifyExtendedEvent {
  const exactExtended = extendedSourceKeyIndex.get(event.sourceEventKey);
  if (exactExtended) {
    return exactMatch(event, { event: exactExtended, deltaMs: 0 }, "EXACT_EXISTING_EXTENDED_HISTORY");
  }

  const estimatedStartMs = event.estimatedStartedAt.getTime();
  const spotifyCandidates = findWithin(
    spotifyIndex.get(event.spotifyTrackId) ?? [],
    estimatedStartMs,
    AMBIGUOUS_MATCH_TOLERANCE_MS,
  );
  const lastFmCandidates = findWithin(
    lastFmNameIndex.get(artistTrackKey(event.artistName, event.trackName)) ?? [],
    estimatedStartMs,
    AMBIGUOUS_MATCH_TOLERANCE_MS,
  );

  const confidentSpotify = spotifyCandidates.filter(
    (candidate) => candidate.deltaMs <= CONFIDENT_MATCH_TOLERANCE_MS,
  );
  const confidentLastFm = lastFmCandidates.filter(
    (candidate) => candidate.deltaMs <= CONFIDENT_MATCH_TOLERANCE_MS,
  );

  const confidentTotal = confidentSpotify.length + confidentLastFm.length;
  if (confidentTotal > 1) {
    return conflict(
      event,
      confidentTotal,
      confidentConflictReason(confidentSpotify.length, confidentLastFm.length),
      nearestDelta([...confidentSpotify, ...confidentLastFm]),
    );
  }

  if (confidentSpotify.length === 1) {
    return exactMatch(event, confidentSpotify[0]!, "EXACT_EXISTING_RECENTLY_PLAYED");
  }

  if (confidentLastFm.length === 1) {
    return exactMatch(event, confidentLastFm[0]!, "EXACT_EXISTING_LASTFM");
  }

  const nearTotal = spotifyCandidates.length + lastFmCandidates.length;
  if (nearTotal > 0) {
    return conflict(
      event,
      nearTotal,
      nearConflictReason(spotifyCandidates.length, lastFmCandidates.length),
      nearestDelta([...spotifyCandidates, ...lastFmCandidates]),
    );
  }

  return {
    event,
    classification: "NEW_UNCOVERED_EVENT",
    matchedExistingEventId: null,
    matchedSource: null,
    matchDeltaMs: null,
    enrichmentCandidate: false,
    candidateCount: 0,
    conflictReason: null,
    nearestCandidateDeltaMs: null,
  };
}

function exactMatch(
  event: SpotifyExtendedMusicEvent,
  match: { event: IndexedExistingEvent; deltaMs: number },
  classification:
    | "EXACT_EXISTING_LASTFM"
    | "EXACT_EXISTING_RECENTLY_PLAYED"
    | "EXACT_EXISTING_EXTENDED_HISTORY",
): ReconciledSpotifyExtendedEvent {
  return {
    event,
    classification,
    matchedExistingEventId: match.event.id,
    matchedSource: match.event.source,
    matchDeltaMs: match.deltaMs,
    enrichmentCandidate:
      classification === "EXACT_EXISTING_EXTENDED_HISTORY"
        ? false
        : !hasExtendedHistoryMetadata(match.event.metadata),
    candidateCount: 1,
    conflictReason: null,
    nearestCandidateDeltaMs: null,
  };
}

function conflict(
  event: SpotifyExtendedMusicEvent,
  candidateCount: number,
  conflictReason: SpotifyExtendedConflictReason,
  nearestCandidateDeltaMs: number | null,
): ReconciledSpotifyExtendedEvent {
  return {
    event,
    classification: "CONFLICT_AMBIGUOUS",
    matchedExistingEventId: null,
    matchedSource: null,
    matchDeltaMs: null,
    enrichmentCandidate: false,
    candidateCount,
    conflictReason,
    nearestCandidateDeltaMs,
  };
}

function confidentConflictReason(
  spotifyCount: number,
  lastFmCount: number,
): SpotifyExtendedConflictReason {
  if (spotifyCount > 0 && lastFmCount > 0) return "CONFIDENT_CROSS_SOURCE";
  if (spotifyCount > 1) return "MULTIPLE_CONFIDENT_SPOTIFY";
  return "MULTIPLE_CONFIDENT_LASTFM";
}

function nearConflictReason(
  spotifyCount: number,
  lastFmCount: number,
): SpotifyExtendedConflictReason {
  if (spotifyCount > 0 && lastFmCount > 0) return "NEAR_CROSS_SOURCE";
  if (spotifyCount > 0) return "NEAR_ONLY_SPOTIFY";
  return "NEAR_ONLY_LASTFM";
}

function nearestDelta(candidates: Candidate[]): number | null {
  if (candidates.length === 0) return null;
  let nearest = candidates[0]!.deltaMs;
  for (const candidate of candidates.slice(1)) {
    if (candidate.deltaMs < nearest) nearest = candidate.deltaMs;
  }
  return nearest;
}

function emptyConflictReasonCounts(): Record<SpotifyExtendedConflictReason, number> {
  return {
    MULTIPLE_CONFIDENT_LASTFM: 0,
    MULTIPLE_CONFIDENT_SPOTIFY: 0,
    CONFIDENT_CROSS_SOURCE: 0,
    NEAR_ONLY_LASTFM: 0,
    NEAR_ONLY_SPOTIFY: 0,
    NEAR_CROSS_SOURCE: 0,
  };
}

function incrementCandidateBucket(
  buckets: SpotifyExtendedReconciliationSummary["conflictCandidateCountBuckets"],
  candidateCount: number,
): void {
  if (candidateCount <= 1) buckets.one += 1;
  else if (candidateCount === 2) buckets.two += 1;
  else if (candidateCount === 3) buckets.three += 1;
  else if (candidateCount === 4) buckets.four += 1;
  else buckets.fiveOrMore += 1;
}

function hasExtendedHistoryMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  return isRecord(metadata.spotifyExtendedHistory);
}

function artistTrackKey(artist: string, track: string): string {
  return `${normalizeText(artist)}\u0000${normalizeText(track)}`;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function pushIndex(
  index: Map<string, IndexedExistingEvent[]>,
  key: string,
  event: IndexedExistingEvent,
): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(event);
  else index.set(key, [event]);
}

function sortIndex(index: Map<string, IndexedExistingEvent[]>): void {
  for (const bucket of index.values()) bucket.sort((a, b) => a.playedAtMs - b.playedAtMs);
}

function findWithin(
  events: IndexedExistingEvent[],
  targetMs: number,
  toleranceMs: number,
): Candidate[] {
  if (events.length === 0) return [];

  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const event = events[mid]!;
    if (event.playedAtMs < targetMs - toleranceMs) low = mid + 1;
    else high = mid;
  }

  const matches: Candidate[] = [];
  for (let index = low; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.playedAtMs > targetMs + toleranceMs) break;
    matches.push({ event, deltaMs: Math.abs(event.playedAtMs - targetMs) });
  }

  matches.sort((a, b) => a.deltaMs - b.deltaMs);
  return matches;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeAbsoluteDeltas(values: number[]): {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
} {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null, maxMs: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] ?? null,
  };
}

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index]!;
}
