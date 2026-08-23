export const DISCOVERY_CONVERSION_POLICY = {
  version: "gate5i-conversion-readonly-v1",
  neverPlayedMaturityDays: 14,
  longTermMaturityDays: 30,
  longTermMinPlays: 3,
  longTermMinDistinctDays: 2,
  attributionRule:
    "CORRELATION_AFTER_FIRST_EXPOSURE__EXACT_TRACK_THEN_ISRC_THEN_IDLESS_TITLE_ARTIST",
} as const;

export type DiscoveryGenerationRunLike = {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  summary: unknown;
};

export type DiscoveryListeningEventLike = {
  spotifyTrackId: string | null;
  spotifyUri?: string | null;
  trackName: string;
  artistName: string;
  isrc: string | null;
  playedAt: Date;
  source?: string | null;
};

export type DiscoveryExposure = {
  runId: string;
  exposedAt: Date;
  targetPlaylistId: string | null;
  targetName: string | null;
  discoveryUri: string;
  spotifyTrackId: string | null;
  discoveryTitle: string;
  discoveryArtist: string | null;
  candidateKey: string | null;
  historyClass: string | null;
  pathLabel: string | null;
  resolutionReason: string | null;
  isrc: string | null;
  adjustedScore: number | null;
};

export type DiscoveryConversionCandidate = {
  identityKey: string;
  spotifyTrackId: string | null;
  isrc: string | null;
  title: string;
  artist: string | null;
  firstExposedAt: Date;
  lastExposedAt: Date;
  exposureCount: number;
  targetNames: string[];
  pathLabels: string[];
  historyClasses: string[];
  resolutionReasons: string[];
  firstPlayedAt: Date | null;
  lastPlayedAt: Date | null;
  playsAfterDiscovery: number;
  distinctListeningDays: number;
  played: boolean;
  replayed: boolean;
  artistExplored: boolean;
  matureForNeverPlayed: boolean;
  neverPlayed: boolean;
  matureForLongTermAffinity: boolean;
  longTermAffinity: boolean;
  matchSources: DiscoveryConversionMatchSource[];
};

export type DiscoveryConversionMatchSource =
  | "SPOTIFY_TRACK_ID"
  | "ISRC"
  | "IDLESS_TITLE_ARTIST";

export type DiscoveryConversionReport = {
  policy: typeof DISCOVERY_CONVERSION_POLICY;
  generatedAt: Date;
  exposureCount: number;
  uniqueDiscoveryCount: number;
  playedCount: number;
  replayedCount: number;
  artistExploredCount: number;
  matureNeverPlayedEligibleCount: number;
  neverPlayedCount: number;
  matureLongTermEligibleCount: number;
  longTermAffinityCount: number;
  playedRate: number | null;
  replayedRate: number | null;
  artistExploredRate: number | null;
  neverPlayedRateAmongMature: number | null;
  longTermAffinityRateAmongMature: number | null;
  candidates: DiscoveryConversionCandidate[];
};

export function extractDiscoveryExposures(
  run: DiscoveryGenerationRunLike,
): DiscoveryExposure[] {
  const summary = asRecord(run.summary);
  const discoveryRuntime = asRecord(summary?.discoveryRuntime);
  const gate5h = asRecord(discoveryRuntime?.gate5h);
  if (gate5h?.applied !== true) return [];
  const evidence = asRecord(gate5h.evidence);
  const replacements = Array.isArray(evidence?.replacements)
    ? evidence.replacements
    : [];
  const exposedAt = run.finishedAt ?? run.startedAt;

  return replacements.flatMap((raw) => {
    const replacement = asRecord(raw);
    if (!replacement) return [];
    const discoveryUri = stringValue(replacement.discoveryUri);
    const discoveryTitle = stringValue(replacement.discoveryTitle);
    if (!discoveryUri || !discoveryTitle) return [];

    return [
      {
        runId: run.id,
        exposedAt,
        targetPlaylistId: stringValue(replacement.targetPlaylistId),
        targetName: stringValue(replacement.targetName),
        discoveryUri,
        spotifyTrackId:
          stringValue(replacement.discoveryTrackId) ?? spotifyTrackIdFromUri(discoveryUri),
        discoveryTitle,
        discoveryArtist: stringValue(replacement.discoveryArtist),
        candidateKey: stringValue(replacement.candidateKey),
        historyClass: stringValue(replacement.historyClass),
        pathLabel: stringValue(replacement.pathLabel),
        resolutionReason: stringValue(replacement.resolutionReason),
        isrc: normalizeIsrc(stringValue(replacement.isrc)),
        adjustedScore: numberValue(replacement.adjustedScore),
      },
    ];
  });
}

export function measureDiscoveryConversion(input: {
  exposures: DiscoveryExposure[];
  listeningEvents: DiscoveryListeningEventLike[];
  asOf?: Date;
}): DiscoveryConversionReport {
  const asOf = input.asOf ?? new Date();
  const grouped = groupExposures(input.exposures);
  const events = [...input.listeningEvents].sort(
    (a, b) => a.playedAt.getTime() - b.playedAt.getTime(),
  );

  const candidates = [...grouped.values()]
    .map((group) => conversionCandidate(group, events, asOf))
    .sort(
      (a, b) =>
        b.firstExposedAt.getTime() - a.firstExposedAt.getTime() ||
        a.identityKey.localeCompare(b.identityKey),
    );

  const uniqueDiscoveryCount = candidates.length;
  const playedCount = candidates.filter((row) => row.played).length;
  const replayedCount = candidates.filter((row) => row.replayed).length;
  const artistExploredCount = candidates.filter((row) => row.artistExplored).length;
  const matureNeverPlayed = candidates.filter((row) => row.matureForNeverPlayed);
  const neverPlayedCount = matureNeverPlayed.filter((row) => row.neverPlayed).length;
  const matureLongTerm = candidates.filter((row) => row.matureForLongTermAffinity);
  const longTermAffinityCount = matureLongTerm.filter((row) => row.longTermAffinity).length;

  return {
    policy: DISCOVERY_CONVERSION_POLICY,
    generatedAt: asOf,
    exposureCount: input.exposures.length,
    uniqueDiscoveryCount,
    playedCount,
    replayedCount,
    artistExploredCount,
    matureNeverPlayedEligibleCount: matureNeverPlayed.length,
    neverPlayedCount,
    matureLongTermEligibleCount: matureLongTerm.length,
    longTermAffinityCount,
    playedRate: rate(playedCount, uniqueDiscoveryCount),
    replayedRate: rate(replayedCount, uniqueDiscoveryCount),
    artistExploredRate: rate(artistExploredCount, uniqueDiscoveryCount),
    neverPlayedRateAmongMature: rate(neverPlayedCount, matureNeverPlayed.length),
    longTermAffinityRateAmongMature: rate(
      longTermAffinityCount,
      matureLongTerm.length,
    ),
    candidates,
  };
}

type ExposureGroup = {
  identityKey: string;
  exposures: DiscoveryExposure[];
};

function groupExposures(exposures: DiscoveryExposure[]): Map<string, ExposureGroup> {
  const groups = new Map<string, ExposureGroup>();
  for (const exposure of exposures) {
    const identityKey = exposureIdentity(exposure);
    const current = groups.get(identityKey);
    if (current) current.exposures.push(exposure);
    else groups.set(identityKey, { identityKey, exposures: [exposure] });
  }
  return groups;
}

function conversionCandidate(
  group: ExposureGroup,
  events: DiscoveryListeningEventLike[],
  asOf: Date,
): DiscoveryConversionCandidate {
  const exposures = [...group.exposures].sort(
    (a, b) => a.exposedAt.getTime() - b.exposedAt.getTime(),
  );
  const first = exposures[0]!;
  const last = exposures[exposures.length - 1]!;
  const matched: Array<{
    event: DiscoveryListeningEventLike;
    source: DiscoveryConversionMatchSource;
  }> = [];

  for (const event of events) {
    if (event.playedAt <= first.exposedAt) continue;
    const source = matchListeningEvent(first, event);
    if (source) matched.push({ event, source });
  }

  const distinctListeningDays = new Set(
    matched.map(({ event }) => utcDay(event.playedAt)),
  ).size;
  const artistExplored = Boolean(
    first.discoveryArtist &&
      events.some(
        (event) =>
          event.playedAt > first.exposedAt &&
          normalized(event.artistName) === normalized(first.discoveryArtist ?? "") &&
          normalized(event.trackName) !== normalized(first.discoveryTitle),
      ),
  );
  const ageDays = Math.max(0, daysBetween(first.exposedAt, asOf));
  const matureForNeverPlayed =
    ageDays >= DISCOVERY_CONVERSION_POLICY.neverPlayedMaturityDays;
  const matureForLongTermAffinity =
    ageDays >= DISCOVERY_CONVERSION_POLICY.longTermMaturityDays;
  const playsAfterDiscovery = matched.length;

  return {
    identityKey: group.identityKey,
    spotifyTrackId: first.spotifyTrackId,
    isrc: first.isrc,
    title: first.discoveryTitle,
    artist: first.discoveryArtist,
    firstExposedAt: first.exposedAt,
    lastExposedAt: last.exposedAt,
    exposureCount: exposures.length,
    targetNames: uniqueStrings(exposures.map((row) => row.targetName)),
    pathLabels: uniqueStrings(exposures.map((row) => row.pathLabel)),
    historyClasses: uniqueStrings(exposures.map((row) => row.historyClass)),
    resolutionReasons: uniqueStrings(exposures.map((row) => row.resolutionReason)),
    firstPlayedAt: matched[0]?.event.playedAt ?? null,
    lastPlayedAt: matched[matched.length - 1]?.event.playedAt ?? null,
    playsAfterDiscovery,
    distinctListeningDays,
    played: playsAfterDiscovery > 0,
    replayed: playsAfterDiscovery >= 2,
    artistExplored,
    matureForNeverPlayed,
    neverPlayed: matureForNeverPlayed && playsAfterDiscovery === 0,
    matureForLongTermAffinity,
    longTermAffinity:
      matureForLongTermAffinity &&
      playsAfterDiscovery >= DISCOVERY_CONVERSION_POLICY.longTermMinPlays &&
      distinctListeningDays >=
        DISCOVERY_CONVERSION_POLICY.longTermMinDistinctDays,
    matchSources: uniqueStrings(matched.map((row) => row.source)) as DiscoveryConversionMatchSource[],
  };
}

function matchListeningEvent(
  exposure: DiscoveryExposure,
  event: DiscoveryListeningEventLike,
): DiscoveryConversionMatchSource | null {
  const eventTrackId = event.spotifyTrackId ?? spotifyTrackIdFromUri(event.spotifyUri ?? "");
  if (
    exposure.spotifyTrackId &&
    eventTrackId &&
    exposure.spotifyTrackId === eventTrackId
  ) {
    return "SPOTIFY_TRACK_ID";
  }

  if (
    exposure.isrc &&
    event.isrc &&
    exposure.isrc === normalizeIsrc(event.isrc)
  ) {
    return "ISRC";
  }

  // Last.fm/import evidence can legitimately be id-less. For provider-tagged
  // events with a different Spotify ID, do not collapse by text alone because
  // alternate/live/remaster recordings may share artist/title.
  if (
    !eventTrackId &&
    exposure.discoveryArtist &&
    normalized(event.artistName) === normalized(exposure.discoveryArtist) &&
    normalized(event.trackName) === normalized(exposure.discoveryTitle)
  ) {
    return "IDLESS_TITLE_ARTIST";
  }

  return null;
}

function exposureIdentity(exposure: DiscoveryExposure): string {
  if (exposure.spotifyTrackId) return `track:${exposure.spotifyTrackId}`;
  if (exposure.isrc) return `isrc:${exposure.isrc}`;
  return `text:${normalized(exposure.discoveryArtist ?? "")}::${normalized(
    exposure.discoveryTitle,
  )}`;
}

function spotifyTrackIdFromUri(uri: string): string | null {
  const match = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri.trim());
  return match?.[1] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeIsrc(value: string | null): string | null {
  const normalizedValue = value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  return normalizedValue || null;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}
