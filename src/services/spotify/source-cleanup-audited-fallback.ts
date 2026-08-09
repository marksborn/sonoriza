import { hashCleanupPlan } from "./source-cleanup";

export type AuditedCleanupBaseline = {
  examinedCount: number;
  removalOccurrenceCount: number;
  plannedUris: string[];
};

export type CachedCleanupCandidate = {
  uri: string;
  spotifyTrackId: string;
};

export type ChangedPlayedTrack = {
  spotifyTrackId: string;
  spotifyUri: string | null;
};

export type AuditedCacheFallbackPlan = {
  examinedCount: number;
  removableTrackCount: number;
  removalOccurrenceCount: number;
  keptCount: number;
  removableUris: string[];
  planHash: string;
};

/**
 * Rebuilds an exact cleanup plan from a previously audited full preview plus
 * the normal MUSIC source cache, but only when every playback-state change
 * since that baseline can be classified deterministically.
 *
 * The baseline preserves removals for tracks intentionally absent from the
 * normal candidate cache (for example unavailable/restricted tracks). New
 * removals are added only for cached source occurrences. If a newly changed
 * playback state is neither already present in the audited plan nor provably
 * present in the candidate cache, the fallback fails closed because source
 * membership is ambiguous without a fresh full playlist read.
 */
export function buildAuditedCacheFallbackPlan(input: {
  baseline: AuditedCleanupBaseline;
  cachedCandidates: CachedCleanupCandidate[];
  playedTrackIds: ReadonlySet<string>;
  changedPlayedTracks: ChangedPlayedTrack[];
}): AuditedCacheFallbackPlan | null {
  const { baseline, cachedCandidates, playedTrackIds, changedPlayedTracks } = input;

  const baselineUris = new Set(baseline.plannedUris);
  const cachedTrackIds = new Set(cachedCandidates.map((candidate) => candidate.spotifyTrackId));
  const cachedUris = new Set(cachedCandidates.map((candidate) => candidate.uri));

  for (const changed of changedPlayedTracks) {
    const canonicalUri = `spotify:track:${changed.spotifyTrackId}`;
    const alreadyAccounted =
      baselineUris.has(canonicalUri) ||
      (typeof changed.spotifyUri === "string" && baselineUris.has(changed.spotifyUri));
    if (alreadyAccounted) continue;

    const provablyCached =
      cachedTrackIds.has(changed.spotifyTrackId) ||
      (typeof changed.spotifyUri === "string" && cachedUris.has(changed.spotifyUri));
    if (!provablyCached) return null;
  }

  const newlyRemovableUris = new Set<string>();
  let newlyRemovableOccurrences = 0;

  for (const candidate of cachedCandidates) {
    if (!playedTrackIds.has(candidate.spotifyTrackId)) continue;
    if (baselineUris.has(candidate.uri)) continue;
    newlyRemovableUris.add(candidate.uri);
    newlyRemovableOccurrences += 1;
  }

  const removableUris = [...new Set([...baselineUris, ...newlyRemovableUris])].sort();
  const removalOccurrenceCount =
    baseline.removalOccurrenceCount + newlyRemovableOccurrences;
  if (removalOccurrenceCount > baseline.examinedCount) return null;

  return {
    examinedCount: baseline.examinedCount,
    removableTrackCount: removableUris.length,
    removalOccurrenceCount,
    keptCount: baseline.examinedCount - removalOccurrenceCount,
    removableUris,
    planHash: hashCleanupPlan(removableUris, removalOccurrenceCount),
  };
}
