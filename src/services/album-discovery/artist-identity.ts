export type HistoricalArtistIdentityRow = {
  primaryArtistId: string | null;
  eventCount: number;
};

export type HistoricalArtistIdentityEvidence = {
  status: "UNAVAILABLE" | "UNIQUE" | "CONFLICT";
  primaryArtistId: string | null;
  identifiedEventCount: number;
  distinctPrimaryArtistIds: number;
  candidates: Array<{ primaryArtistId: string; eventCount: number }>;
};

/**
 * ALBUM-01 Gate 1B.
 *
 * Artist-name search is not an identity authority because Spotify can contain
 * multiple unrelated artists with the same display name. HISTORY-02 already
 * preserves primaryArtistId on canonical listening evidence, so Gate 1B uses
 * that evidence only when it is unambiguous. A conflict never falls back to
 * popularity, result order or fuzzy guessing.
 */
export function buildHistoricalArtistIdentityEvidence(
  rows: HistoricalArtistIdentityRow[],
): HistoricalArtistIdentityEvidence {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const primaryArtistId = row.primaryArtistId?.trim() || null;
    if (!primaryArtistId) continue;
    const eventCount = Number.isFinite(row.eventCount)
      ? Math.max(0, Math.trunc(row.eventCount))
      : 0;
    counts.set(primaryArtistId, (counts.get(primaryArtistId) ?? 0) + eventCount);
  }

  const candidates = [...counts.entries()]
    .map(([primaryArtistId, eventCount]) => ({ primaryArtistId, eventCount }))
    .sort(
      (a, b) =>
        b.eventCount - a.eventCount || a.primaryArtistId.localeCompare(b.primaryArtistId),
    );
  const identifiedEventCount = candidates.reduce(
    (sum, row) => sum + row.eventCount,
    0,
  );

  if (candidates.length === 0) {
    return {
      status: "UNAVAILABLE",
      primaryArtistId: null,
      identifiedEventCount: 0,
      distinctPrimaryArtistIds: 0,
      candidates: [],
    };
  }

  if (candidates.length === 1) {
    return {
      status: "UNIQUE",
      primaryArtistId: candidates[0]!.primaryArtistId,
      identifiedEventCount,
      distinctPrimaryArtistIds: 1,
      candidates,
    };
  }

  return {
    status: "CONFLICT",
    primaryArtistId: null,
    identifiedEventCount,
    distinctPrimaryArtistIds: candidates.length,
    candidates,
  };
}
