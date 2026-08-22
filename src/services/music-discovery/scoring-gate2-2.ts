import type { DiscoveryTrackProfile } from "./profile";
import { normalizeRecordingRecency } from "./recording-recency";
import { buildDiscoveryScoringReportEligibleOnly } from "./scoring-eligible-only";
import {
  DISCOVERY_SCORE_CALIBRATION,
  type BuildDiscoveryScoringInput,
  type DiscoveryArtistScoreCard,
  type DiscoveryScoredArtistCandidate,
  type DiscoveryScoredTrackCandidate,
  type DiscoveryScoreReason,
  type DiscoveryScoringReport,
} from "./scoring";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

export const DISCOVERY_GATE22_VERSION = "gate2.2-v1" as const;

export type DiscoveryGate22ReasonCode =
  | DiscoveryScoreReason["code"]
  | "MILD_EXPLICIT_SKIP_PENALTY";

export type DiscoveryGate22Reason = Omit<DiscoveryScoreReason, "code"> & {
  code: DiscoveryGate22ReasonCode;
};

export type DiscoveryGate22TrackCandidate = Omit<
  DiscoveryScoredTrackCandidate,
  "reasons"
> & {
  reasons: DiscoveryGate22Reason[];
};

export type DiscoveryGate22ArtistScoreCard = Omit<
  DiscoveryArtistScoreCard,
  "reasons"
> & {
  reasons: DiscoveryGate22Reason[];
};

export type DiscoveryGate22ArtistCandidate = Omit<
  DiscoveryScoredArtistCandidate,
  "reasons"
> & {
  reasons: DiscoveryGate22Reason[];
};

export type RecordingIdentityMatchSource =
  | "ISRC"
  | "SPOTIFY_PRIMARY_ARTIST_TITLE"
  | "CANONICAL_ARTIST_TITLE";

export type DiscoveryGate22ScoringReport = Omit<
  DiscoveryScoringReport,
  | "version"
  | "selectionPolicy"
  | "topArtistAffinity"
  | "familiarCandidates"
  | "rediscoveryCandidates"
  | "rediscoveryReturns"
  | "deepeningCandidates"
> & {
  version: typeof DISCOVERY_GATE22_VERSION;
  selectionPolicy: DiscoveryScoringReport["selectionPolicy"] & {
    recordingIdentityPolicy: "ISRC_THEN_CONSERVATIVE_ARTIST_TITLE";
    recordingRecencyPolicy: "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN";
    recordingRecencyAdjustedLastPlayedCount: number;
    recordingRecencyAdjustedCooldownLastPlayedCount: number;
    recordingRecencyAdjustedCooldownEligibilityCount: number;
    rediscoveryPreemptedFamiliarBySpotifyIdCount: number;
    rediscoveryPreemptedFamiliarByRecordingIdentityCount: number;
    recordingIdentityMatchSources: Record<RecordingIdentityMatchSource, number>;
  };
  topArtistAffinity: DiscoveryGate22ArtistScoreCard[];
  familiarCandidates: DiscoveryGate22TrackCandidate[];
  rediscoveryCandidates: DiscoveryGate22TrackCandidate[];
  rediscoveryReturns: DiscoveryGate22ArtistCandidate[];
  deepeningCandidates: DiscoveryGate22ArtistCandidate[];
};

export type BuildDiscoveryGate22ScoringInput = BuildDiscoveryScoringInput & {
  trackIdentities: DiscoveryTrackIdentityEvidence[];
};

type TrackWithIdentity = Pick<
  DiscoveryTrackProfile,
  "spotifyTrackId" | "trackName" | "artistName"
> & {
  evidence: DiscoveryTrackIdentityEvidence | null;
};

export function buildDiscoveryGate22ScoringReport(
  input: BuildDiscoveryGate22ScoringInput,
): DiscoveryGate22ScoringReport {
  // Spotify can expose the same recording under multiple track IDs because of
  // releases/licensing/market relinking. Normalize the freshest observed play
  // and MUSIC-01 cooldown across conservative recording identity *before*
  // Gate 2.1 category scoring, so an old release cannot become REDESCOBERTA
  // while an equivalent release was played recently.
  const recordingRecency = normalizeRecordingRecency({
    tracks: input.tracks,
    trackIdentities: input.trackIdentities,
    match: recordingIdentityMatchSource,
  });
  const scoringTracks = recordingRecency.tracks;
  const expandedTopN = Math.max(
    input.topN,
    input.artists.length,
    scoringTracks.length,
  );
  const base = buildDiscoveryScoringReportEligibleOnly({
    ...input,
    tracks: scoringTracks,
    topN: expandedTopN,
  });

  // PERF-01: avoid allocating a temporary tuple array just to build these Maps.
  // With the COMPLETE universe, track profiles can contain tens of thousands of rows.
  const identityByTrackId = new Map<string, DiscoveryTrackIdentityEvidence>();
  for (const row of input.trackIdentities) {
    identityByTrackId.set(row.spotifyTrackId, row);
  }
  const profileByTrackId = new Map<string, DiscoveryTrackProfile>();
  for (const track of scoringTracks) {
    profileByTrackId.set(track.spotifyTrackId, track);
  }

  // PERF-01: Gate 2.1 already owns fresh score objects. Gate 2.2 only widens
  // reason semantics, so normalize those objects in place instead of cloning
  // every candidate and every reasons[] array for the COMPLETE universe.
  const rediscovery = base.rediscoveryCandidates as DiscoveryGate22TrackCandidate[];
  for (const candidate of base.rediscoveryCandidates) {
    normalizeTrackCandidateReasonsInPlace(candidate);
  }

  const recordingIdentityMatchSources: Record<RecordingIdentityMatchSource, number> = {
    ISRC: 0,
    SPOTIFY_PRIMARY_ARTIST_TITLE: 0,
    CANONICAL_ARTIST_TITLE: 0,
  };
  let recordingIdentityPreemptions = 0;

  for (const candidate of base.familiarCandidates) {
    normalizeTrackCandidateReasonsInPlace(candidate);
  }
  const familiar = (base.familiarCandidates as DiscoveryGate22TrackCandidate[]).filter(
    (candidate) => {
      const familiarTrack = profileByTrackId.get(candidate.spotifyTrackId);
      if (!familiarTrack) return true;
      const familiarIdentity = withIdentity(familiarTrack, identityByTrackId);

      for (const rediscoveryCandidate of rediscovery) {
        const rediscoveryTrack = profileByTrackId.get(
          rediscoveryCandidate.spotifyTrackId,
        );
        if (!rediscoveryTrack) continue;
        const matchSource = recordingIdentityMatchSource(
          familiarIdentity,
          withIdentity(rediscoveryTrack, identityByTrackId),
        );
        if (!matchSource) continue;
        recordingIdentityPreemptions += 1;
        recordingIdentityMatchSources[matchSource] += 1;
        return false;
      }
      return true;
    },
  );

  for (const row of base.topArtistAffinity) normalizeArtistScoreReasonsInPlace(row);
  for (const row of base.rediscoveryReturns) normalizeArtistCandidateReasonsInPlace(row);
  for (const row of base.deepeningCandidates) normalizeArtistCandidateReasonsInPlace(row);

  const spotifyIdPreemptions =
    base.selectionPolicy.rediscoveryPreemptedFamiliarCount;

  return {
    ...base,
    version: DISCOVERY_GATE22_VERSION,
    selectionPolicy: {
      ...base.selectionPolicy,
      recordingIdentityPolicy: "ISRC_THEN_CONSERVATIVE_ARTIST_TITLE",
      recordingRecencyPolicy: recordingRecency.evidence.policy,
      recordingRecencyAdjustedLastPlayedCount:
        recordingRecency.evidence.adjustedLastPlayedCount,
      recordingRecencyAdjustedCooldownLastPlayedCount:
        recordingRecency.evidence.adjustedCooldownLastPlayedCount,
      recordingRecencyAdjustedCooldownEligibilityCount:
        recordingRecency.evidence.adjustedCooldownEligibilityCount,
      rediscoveryPreemptedFamiliarBySpotifyIdCount: spotifyIdPreemptions,
      rediscoveryPreemptedFamiliarByRecordingIdentityCount:
        recordingIdentityPreemptions,
      rediscoveryPreemptedFamiliarCount:
        spotifyIdPreemptions + recordingIdentityPreemptions,
      recordingIdentityMatchSources,
    },
    topArtistAffinity: limitRows(
      base.topArtistAffinity as DiscoveryGate22ArtistScoreCard[],
      input.topN,
    ),
    familiarCandidates: limitRows(familiar, input.topN),
    rediscoveryCandidates: limitRows(rediscovery, input.topN),
    rediscoveryReturns: limitRows(
      base.rediscoveryReturns as DiscoveryGate22ArtistCandidate[],
      input.topN,
    ),
    deepeningCandidates: limitRows(
      base.deepeningCandidates as DiscoveryGate22ArtistCandidate[],
      input.topN,
    ),
  };
}

export function recordingIdentityMatchSource(
  a: TrackWithIdentity,
  b: TrackWithIdentity,
): RecordingIdentityMatchSource | null {
  if (a.spotifyTrackId === b.spotifyTrackId) return null;

  const aEvidence = a.evidence;
  const bEvidence = b.evidence;
  if (aEvidence?.isrcConflict || bEvidence?.isrcConflict) return null;
  if (aEvidence?.primaryArtistIdConflict || bEvidence?.primaryArtistIdConflict) {
    return null;
  }

  if (aEvidence?.isrc && bEvidence?.isrc) {
    return aEvidence.isrc === bEvidence.isrc ? "ISRC" : null;
  }

  const aTitle = normalized(a.trackName);
  const bTitle = normalized(b.trackName);
  if (!aTitle || aTitle !== bTitle) return null;
  if (hasVersionQualifier(a.trackName) || hasVersionQualifier(b.trackName)) {
    return null;
  }

  if (aEvidence?.primaryArtistId && bEvidence?.primaryArtistId) {
    return aEvidence.primaryArtistId === bEvidence.primaryArtistId
      ? "SPOTIFY_PRIMARY_ARTIST_TITLE"
      : null;
  }

  return normalized(a.artistName) === normalized(b.artistName)
    ? "CANONICAL_ARTIST_TITLE"
    : null;
}

function withIdentity(
  track: DiscoveryTrackProfile,
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>,
): TrackWithIdentity {
  return {
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    evidence: identityByTrackId.get(track.spotifyTrackId) ?? null,
  };
}

function normalizeArtistScoreReasonsInPlace(row: DiscoveryArtistScoreCard): void {
  normalizeSkipReasonSemanticsInPlace(
    row.reasons,
    row.components.adjustedExplicitSkipRate,
    row.components.negativePenalty,
  );
}

function normalizeArtistCandidateReasonsInPlace(
  row: DiscoveryScoredArtistCandidate,
): void {
  normalizeSkipReasonSemanticsInPlace(
    row.reasons,
    row.components.adjustedExplicitSkipRate,
    row.components.negativePenalty,
  );
}

function normalizeTrackCandidateReasonsInPlace(
  row: DiscoveryScoredTrackCandidate,
): void {
  normalizeSkipReasonSemanticsInPlace(
    row.reasons,
    row.components.adjustedExplicitSkipRate,
    row.components.negativePenalty,
  );
}

function normalizeSkipReasonSemanticsInPlace(
  reasons: DiscoveryScoreReason[],
  adjustedSkipRate: number,
  negativePenalty: number,
): void {
  for (const reason of reasons) {
    if (
      reason.code !== "ELEVATED_EXPLICIT_SKIP_RATE" &&
      reason.code !== "HIGH_EXPLICIT_SKIP_RATE"
    ) {
      continue;
    }

    const mutable = reason as DiscoveryGate22Reason;
    if (
      adjustedSkipRate >=
      DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.strongNegativeRate
    ) {
      mutable.code = "HIGH_EXPLICIT_SKIP_RATE";
      continue;
    }
    if (
      adjustedSkipRate >= DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.elevatedRate
    ) {
      mutable.code = "ELEVATED_EXPLICIT_SKIP_RATE";
      continue;
    }
    if (negativePenalty > 0) {
      mutable.code = "MILD_EXPLICIT_SKIP_PENALTY";
    }
  }
}

function limitRows<T>(rows: T[], count: number): T[] {
  return rows.length <= count ? rows : rows.slice(0, count);
}

function hasVersionQualifier(value: string): boolean {
  return /(?:\(|\[|\s[-–—]\s)[^\n]*(?:live|remaster(?:ed)?|remix|acoustic|demo|instrumental|karaoke|radio\s+edit|version|edit|mono|stereo|session|unplugged|re-?record(?:ed)?)/i.test(
    value,
  );
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}
