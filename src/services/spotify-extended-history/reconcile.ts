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
  metadata: unknown;
};

export type SpotifyExtendedClassification =
  | "EXACT_EXISTING_LASTFM"
  | "EXACT_EXISTING_RECENTLY_PLAYED"
  | "NEW_UNCOVERED_EVENT"
  | "CONFLICT_AMBIGUOUS";

export type ReconciledSpotifyExtendedEvent = {
  event: SpotifyExtendedMusicEvent;
  classification: SpotifyExtendedClassification;
  matchedExistingEventId: string | null;
  matchedSource: string | null;
  matchDeltaMs: number | null;
  enrichmentCandidate: boolean;
  candidateCount: number;
};

export type SpotifyExtendedReconciliationSummary = {
  totalUniqueExportEvents: number;
  exactExistingLastFm: number;
  exactExistingRecentlyPlayed: number;
  newUncoveredEvents: number;
  conflictAmbiguous: number;
  enrichmentCandidates: number;
  estimatedInserts: number;
  lastFmMatchDeltaMs: number[];
  recentlyPlayedMatchDeltaMs: number[];
};

export type SpotifyExtendedReconciliation = {
  entries: ReconciledSpotifyExtendedEvent[];
  summary: SpotifyExtendedReconciliationSummary;
};

type IndexedExistingEvent = ExistingListeningEvent & { playedAtMs: number };

export function reconcileSpotifyExtendedHistory(
  exportEvents: SpotifyExtendedMusicEvent[],
  existingEvents: ExistingListeningEvent[],
): SpotifyExtendedReconciliation {
  const spotifyIndex = new Map<string, IndexedExistingEvent[]>();
  const lastFmNameIndex = new Map<string, IndexedExistingEvent[]>();

  for (const existing of existingEvents) {
    const indexed: IndexedExistingEvent = { ...existing, playedAtMs: existing.playedAt.getTime() };

    if (existing.source === "SPOTIFY_RECENTLY_PLAYED" && existing.spotifyTrackId) {
      pushIndex(spotifyIndex, existing.spotifyTrackId, indexed);
    }

    if (existing.source === "LASTFM_SCROBBLE") {
      pushIndex(lastFmNameIndex, artistTrackKey(existing.artistName, existing.trackName), indexed);
    }
  }

  sortIndex(spotifyIndex);
  sortIndex(lastFmNameIndex);

  const entries = exportEvents.map((event) => reconcileOne(event, spotifyIndex, lastFmNameIndex));

  const summary: SpotifyExtendedReconciliationSummary = {
    totalUniqueExportEvents: entries.length,
    exactExistingLastFm: 0,
    exactExistingRecentlyPlayed: 0,
    newUncoveredEvents: 0,
    conflictAmbiguous: 0,
    enrichmentCandidates: 0,
    estimatedInserts: 0,
    lastFmMatchDeltaMs: [],
    recentlyPlayedMatchDeltaMs: [],
  };

  for (const entry of entries) {
    if (entry.classification === "EXACT_EXISTING_LASTFM") {
      summary.exactExistingLastFm += 1;
      if (entry.matchDeltaMs !== null) summary.lastFmMatchDeltaMs.push(entry.matchDeltaMs);
    } else if (entry.classification === "EXACT_EXISTING_RECENTLY_PLAYED") {
      summary.exactExistingRecentlyPlayed += 1;
      if (entry.matchDeltaMs !== null) summary.recentlyPlayedMatchDeltaMs.push(entry.matchDeltaMs);
    } else if (entry.classification === "NEW_UNCOVERED_EVENT") {
      summary.newUncoveredEvents += 1;
      summary.estimatedInserts += 1;
    } else {
      summary.conflictAmbiguous += 1;
    }

    if (entry.enrichmentCandidate) summary.enrichmentCandidates += 1;
  }

  return { entries, summary };
}

function reconcileOne(
  event: SpotifyExtendedMusicEvent,
  spotifyIndex: Map<string, IndexedExistingEvent[]>,
  lastFmNameIndex: Map<string, IndexedExistingEvent[]>,
): ReconciledSpotifyExtendedEvent {
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
  if (confidentTotal > 1) return conflict(event, confidentTotal);

  if (confidentSpotify.length === 1) {
    return exactMatch(event, confidentSpotify[0]!, "EXACT_EXISTING_RECENTLY_PLAYED");
  }

  if (confidentLastFm.length === 1) {
    return exactMatch(event, confidentLastFm[0]!, "EXACT_EXISTING_LASTFM");
  }

  const nearTotal = spotifyCandidates.length + lastFmCandidates.length;
  if (nearTotal > 0) return conflict(event, nearTotal);

  return {
    event,
    classification: "NEW_UNCOVERED_EVENT",
    matchedExistingEventId: null,
    matchedSource: null,
    matchDeltaMs: null,
    enrichmentCandidate: false,
    candidateCount: 0,
  };
}

function exactMatch(
  event: SpotifyExtendedMusicEvent,
  match: { event: IndexedExistingEvent; deltaMs: number },
  classification: "EXACT_EXISTING_LASTFM" | "EXACT_EXISTING_RECENTLY_PLAYED",
): ReconciledSpotifyExtendedEvent {
  return {
    event,
    classification,
    matchedExistingEventId: match.event.id,
    matchedSource: match.event.source,
    matchDeltaMs: match.deltaMs,
    enrichmentCandidate: !hasExtendedHistoryMetadata(match.event.metadata),
    candidateCount: 1,
  };
}

function conflict(event: SpotifyExtendedMusicEvent, candidateCount: number): ReconciledSpotifyExtendedEvent {
  return {
    event,
    classification: "CONFLICT_AMBIGUOUS",
    matchedExistingEventId: null,
    matchedSource: null,
    matchDeltaMs: null,
    enrichmentCandidate: false,
    candidateCount,
  };
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
): { event: IndexedExistingEvent; deltaMs: number }[] {
  if (events.length === 0) return [];

  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const event = events[mid]!;
    if (event.playedAtMs < targetMs - toleranceMs) low = mid + 1;
    else high = mid;
  }

  const matches: { event: IndexedExistingEvent; deltaMs: number }[] = [];
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
