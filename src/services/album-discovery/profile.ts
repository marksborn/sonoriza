import type {
  SpotifyAlbumCatalogSummary,
  SpotifyAlbumCatalogTrack,
} from "@/services/spotify/album-catalog";

const DAY_MS = 86_400_000;

export const ALBUM_DISCOVERY_GATE1_POLICY = {
  version: "album-gate1-profile-readonly-v1",
  catalogUnit: "SPOTIFY_ALBUM_ID_EDITION",
  canonicalMatchRule: "TRACK_ID_OR_EXACT_ALBUM_ID_AND_UNIQUE_TITLE",
  labelMatchRule: "IDLESS_EXACT_ARTIST_ALBUM_TITLE_ANALYTICS_ONLY",
  coverageMeaning:
    "Coverage is observed-history coverage, not proof that a track was completed or learned. Label-only evidence is exposed separately and never promoted to canonical Spotify identity.",
} as const;

export type AlbumCoverageConfidence =
  | "NO_HISTORY"
  | "CANONICAL_ONLY"
  | "LABEL_ONLY"
  | "MIXED_CANONICAL_AND_LABEL";

export type AlbumHistoryEvent = {
  spotifyTrackId: string | null;
  trackName: string;
  artistName: string;
  primaryArtistId: string | null;
  albumName: string | null;
  albumId: string | null;
  playedAt: Date;
  source: string;
  metadata: unknown;
};

export type AlbumCoverageFacts = {
  policyVersion: typeof ALBUM_DISCOVERY_GATE1_POLICY.version;
  spotifyAlbumId: string;
  albumName: string;
  releaseDate: string | null;
  catalogTrackCount: number;
  eligibleTrackCount: number;
  unavailableTrackCount: number;
  canonicalObservedTrackCount: number;
  labelOnlyObservedTrackCount: number;
  observedTrackCount: number;
  canonicalCoverage: number | null;
  analyticCoverage: number | null;
  confidence: AlbumCoverageConfidence;
  matchedEventCount: number;
  explicitSkipEventCount: number;
  plays30d: number;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
};

export function buildAlbumCoverageFacts(input: {
  album: SpotifyAlbumCatalogSummary;
  tracks: SpotifyAlbumCatalogTrack[];
  events: AlbumHistoryEvent[];
  spotifyArtistId: string;
  spotifyArtistName: string;
  asOf: Date;
}): AlbumCoverageFacts {
  const eligibleTracks = input.tracks.filter((track) => track.isPlayable);
  const trackById = new Map(eligibleTracks.map((track) => [track.id, track] as const));
  const tracksByTitle = new Map<string, SpotifyAlbumCatalogTrack[]>();
  for (const track of eligibleTracks) {
    const key = normalized(track.name);
    const current = tracksByTitle.get(key) ?? [];
    current.push(track);
    tracksByTitle.set(key, current);
  }

  const canonicalTrackIds = new Set<string>();
  const labelTrackIds = new Set<string>();
  let matchedEventCount = 0;
  let explicitSkipEventCount = 0;
  let plays30d = 0;
  let firstObservedAt: Date | null = null;
  let lastObservedAt: Date | null = null;
  const cutoff30d = new Date(input.asOf.getTime() - 30 * DAY_MS);

  for (const event of input.events) {
    if (event.playedAt > input.asOf) continue;
    if (!artistMatches(event, input.spotifyArtistId, input.spotifyArtistName)) continue;

    let track: SpotifyAlbumCatalogTrack | null = null;
    let match: "CANONICAL" | "LABEL" | null = null;

    if (event.spotifyTrackId) {
      track = trackById.get(event.spotifyTrackId) ?? null;
      if (track) match = "CANONICAL";
    }

    if (!track && event.albumId === input.album.id) {
      track = uniqueTitleTrack(tracksByTitle, event.trackName);
      if (track) match = "CANONICAL";
    }

    if (
      !track &&
      !event.spotifyTrackId &&
      !event.albumId &&
      event.albumName &&
      normalized(event.albumName) === normalized(input.album.name)
    ) {
      track = uniqueTitleTrack(tracksByTitle, event.trackName);
      if (track) match = "LABEL";
    }

    if (!track || !match) continue;

    matchedEventCount += 1;
    if (match === "CANONICAL") canonicalTrackIds.add(track.id);
    else labelTrackIds.add(track.id);
    if (extendedExplicitSkip(event.metadata)) explicitSkipEventCount += 1;
    if (event.playedAt >= cutoff30d) plays30d += 1;
    if (!firstObservedAt || event.playedAt < firstObservedAt) {
      firstObservedAt = event.playedAt;
    }
    if (!lastObservedAt || event.playedAt > lastObservedAt) {
      lastObservedAt = event.playedAt;
    }
  }

  for (const trackId of canonicalTrackIds) labelTrackIds.delete(trackId);

  const canonicalObservedTrackCount = canonicalTrackIds.size;
  const labelOnlyObservedTrackCount = labelTrackIds.size;
  const observedTrackCount = canonicalObservedTrackCount + labelOnlyObservedTrackCount;
  const denominator = eligibleTracks.length;

  return {
    policyVersion: ALBUM_DISCOVERY_GATE1_POLICY.version,
    spotifyAlbumId: input.album.id,
    albumName: input.album.name,
    releaseDate: input.album.releaseDate,
    catalogTrackCount: input.tracks.length,
    eligibleTrackCount: denominator,
    unavailableTrackCount: input.tracks.length - denominator,
    canonicalObservedTrackCount,
    labelOnlyObservedTrackCount,
    observedTrackCount,
    canonicalCoverage: rate(canonicalObservedTrackCount, denominator),
    analyticCoverage: rate(observedTrackCount, denominator),
    confidence: coverageConfidence(
      canonicalObservedTrackCount,
      labelOnlyObservedTrackCount,
    ),
    matchedEventCount,
    explicitSkipEventCount,
    plays30d,
    firstObservedAt,
    lastObservedAt,
  };
}

/**
 * Gate 1 intentionally samples both albums already represented in history and
 * albums with no observed history, so the real-data report can calibrate both
 * sides without crawling an artist's entire catalog on the first pass.
 */
export function selectDiagnosticAlbumSample(input: {
  albums: SpotifyAlbumCatalogSummary[];
  events: AlbumHistoryEvent[];
  maxAlbums: number;
}): SpotifyAlbumCatalogSummary[] {
  const maxAlbums = positiveInteger(input.maxAlbums, "maxAlbums", 100);
  if (input.albums.length <= maxAlbums) return [...input.albums];

  const observedIds = new Set(
    input.events.map((event) => event.albumId).filter((value): value is string => Boolean(value)),
  );
  const idlessLabels = new Set(
    input.events
      .filter((event) => !event.albumId && Boolean(event.albumName))
      .map((event) => normalized(event.albumName ?? "")),
  );
  const sorted = [...input.albums].sort(byReleaseDateDescending);
  const observed = sorted.filter(
    (album) => observedIds.has(album.id) || idlessLabels.has(normalized(album.name)),
  );
  const unseen = sorted.filter(
    (album) => !observedIds.has(album.id) && !idlessLabels.has(normalized(album.name)),
  );

  const observedBudget = Math.ceil(maxAlbums / 2);
  const unseenBudget = Math.floor(maxAlbums / 2);
  const selected = [
    ...observed.slice(0, observedBudget),
    ...unseen.slice(0, unseenBudget),
  ];
  if (selected.length < maxAlbums) {
    const selectedIds = new Set(selected.map((album) => album.id));
    for (const album of sorted) {
      if (selectedIds.has(album.id)) continue;
      selected.push(album);
      selectedIds.add(album.id);
      if (selected.length >= maxAlbums) break;
    }
  }
  return selected;
}

function artistMatches(
  event: AlbumHistoryEvent,
  spotifyArtistId: string,
  spotifyArtistName: string,
): boolean {
  if (event.primaryArtistId) return event.primaryArtistId === spotifyArtistId;
  return normalized(event.artistName) === normalized(spotifyArtistName);
}

function uniqueTitleTrack(
  tracksByTitle: Map<string, SpotifyAlbumCatalogTrack[]>,
  trackName: string,
): SpotifyAlbumCatalogTrack | null {
  const matches = tracksByTitle.get(normalized(trackName)) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

function coverageConfidence(
  canonicalCount: number,
  labelOnlyCount: number,
): AlbumCoverageConfidence {
  if (canonicalCount === 0 && labelOnlyCount === 0) return "NO_HISTORY";
  if (canonicalCount > 0 && labelOnlyCount === 0) return "CANONICAL_ONLY";
  if (canonicalCount === 0) return "LABEL_ONLY";
  return "MIXED_CANONICAL_AND_LABEL";
}

function extendedExplicitSkip(metadata: unknown): boolean {
  const root = record(metadata);
  const evidence = record(root?.spotifyExtendedHistory);
  return evidence?.explicitSkip === true;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function byReleaseDateDescending(
  a: SpotifyAlbumCatalogSummary,
  b: SpotifyAlbumCatalogSummary,
): number {
  return String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? "")) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id);
}

function positiveInteger(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}
