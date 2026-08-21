import type { DiscoveryTrackProfile } from "./profile";
import {
  buildDiscoveryScoringReport,
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
  const expandedTopN = Math.max(
    input.topN,
    input.artists.length,
    input.tracks.length,
  );
  const base = buildDiscoveryScoringReport({
    ...input,
    topN: expandedTopN,
  });
  const identityByTrackId = new Map(
    input.trackIdentities.map((row) => [row.spotifyTrackId, row] as const),
  );
  const profileByTrackId = new Map(
    input.tracks.map((track) => [track.spotifyTrackId, track] as const),
  );

  const rediscovery = base.rediscoveryCandidates.map((candidate) =>
    normalizeTrackCandidateReasons(candidate),
  );
  const recordingIdentityMatchSources: Record<RecordingIdentityMatchSource, number> = {
    ISRC: 0,
    SPOTIFY_PRIMARY_ARTIST_TITLE: 0,
    CANONICAL_ARTIST_TITLE: 0,
  };
  let recordingIdentityPreemptions = 0;

  const familiar = base.familiarCandidates
    .map((candidate) => normalizeTrackCandidateReasons(candidate))
    .filter((candidate) => {
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
    });

  const spotifyIdPreemptions =
    base.selectionPolicy.rediscoveryPreemptedFamiliarCount;

  return {
    ...base,
    version: DISCOVERY_GATE22_VERSION,
    selectionPolicy: {
      ...base.selectionPolicy,
      recordingIdentityPolicy: "ISRC_THEN_CONSERVATIVE_ARTIST_TITLE",
      rediscoveryPreemptedFamiliarBySpotifyIdCount: spotifyIdPreemptions,
      rediscoveryPreemptedFamiliarByRecordingIdentityCount:
        recordingIdentityPreemptions,
      rediscoveryPreemptedFamiliarCount:
        spotifyIdPreemptions + recordingIdentityPreemptions,
      recordingIdentityMatchSources,
    },
    topArtistAffinity: base.topArtistAffinity
      .map(normalizeArtistScoreReasons)
      .slice(0, input.topN),
    familiarCandidates: familiar.slice(0, input.topN),
    rediscoveryCandidates: rediscovery.slice(0, input.topN),
    rediscoveryReturns: base.rediscoveryReturns
      .map(normalizeArtistCandidateReasons)
      .slice(0, input.topN),
    deepeningCandidates: base.deepeningCandidates
      .map(normalizeArtistCandidateReasons)
      .slice(0, input.topN),
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

function normalizeArtistScoreReasons(
  row: DiscoveryArtistScoreCard,
): DiscoveryGate22ArtistScoreCard {
  return {
    ...row,
    reasons: normalizeSkipReasonSemantics(
      row.reasons,
      row.components.adjustedExplicitSkipRate,
      row.components.negativePenalty,
    ),
  };
}

function normalizeArtistCandidateReasons(
  row: DiscoveryScoredArtistCandidate,
): DiscoveryGate22ArtistCandidate {
  return {
    ...row,
    reasons: normalizeSkipReasonSemantics(
      row.reasons,
      row.components.adjustedExplicitSkipRate,
      row.components.negativePenalty,
    ),
  };
}

function normalizeTrackCandidateReasons(
  row: DiscoveryScoredTrackCandidate,
): DiscoveryGate22TrackCandidate {
  return {
    ...row,
    reasons: normalizeSkipReasonSemantics(
      row.reasons,
      row.components.adjustedExplicitSkipRate,
      row.components.negativePenalty,
    ),
  };
}

function normalizeSkipReasonSemantics(
  reasons: DiscoveryScoreReason[],
  adjustedSkipRate: number,
  negativePenalty: number,
): DiscoveryGate22Reason[] {
  return reasons.map((reason) => {
    if (
      reason.code !== "ELEVATED_EXPLICIT_SKIP_RATE" &&
      reason.code !== "HIGH_EXPLICIT_SKIP_RATE"
    ) {
      return reason;
    }

    if (
      adjustedSkipRate >=
      DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.strongNegativeRate
    ) {
      return { ...reason, code: "HIGH_EXPLICIT_SKIP_RATE" };
    }
    if (
      adjustedSkipRate >= DISCOVERY_SCORE_CALIBRATION.skipBayesPrior.elevatedRate
    ) {
      return { ...reason, code: "ELEVATED_EXPLICIT_SKIP_RATE" };
    }
    if (negativePenalty > 0) {
      return { ...reason, code: "MILD_EXPLICIT_SKIP_PENALTY" };
    }
    return reason;
  });
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
