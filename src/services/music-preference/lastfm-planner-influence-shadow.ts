import {
  lineageFromRootSource,
  policyDecisionForLineage,
  type PolicyDecision,
} from "@/services/data-policy";

import type { FirstPartyPlaybackPreference } from "./first-party-playback-preference";
import {
  FIRST_PARTY_SPOTIFY_ARTIST_SUBJECT_PREFIX,
  FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX,
} from "./first-party-planner-preferences";
import { normalizeMusicIdentityText } from "./lastfm-coverage";
import type {
  Music06ArtistNegativeProjection,
  Music06NegativeProjectionShadow,
  Music06TrackNegativeProjection,
} from "./lastfm-negative-projection-shadow";

export const MUSIC_06_PLANNER_INFLUENCE_SHADOW_POLICY_VERSION =
  "music-06-gate5-shadow-v1" as const;

export type Music06PlannerInfluenceConfig = Readonly<{
  track: Readonly<{
    minAssessedOccurrenceCount: number;
    minNegativeOccurrenceCount: number;
    minDistinctNegativeDays: number;
    minSkipRate: number;
    maxMusicRankShift: number;
  }>;
  artist: Readonly<{
    minAssessedOccurrenceCount: number;
    minNegativeOccurrenceCount: number;
    minDistinctTracksNegative: number;
    minDistinctNegativeDays: number;
    minSkipRate: number;
    maxMusicRankShift: number;
  }>;
  maxCombinedMusicRankShift: number;
}>;

/**
 * Provisional Gate 5 shadow calibration only. These values are deliberately
 * conservative and configurable; they are not a final productive policy.
 */
export const DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG =
  Object.freeze<Music06PlannerInfluenceConfig>({
    track: {
      minAssessedOccurrenceCount: 3,
      minNegativeOccurrenceCount: 2,
      minDistinctNegativeDays: 2,
      minSkipRate: 0.5,
      maxMusicRankShift: 2,
    },
    artist: {
      minAssessedOccurrenceCount: 6,
      minNegativeOccurrenceCount: 3,
      minDistinctTracksNegative: 2,
      minDistinctNegativeDays: 2,
      minSkipRate: 0.5,
      maxMusicRankShift: 1,
    },
    maxCombinedMusicRankShift: 3,
  });

export type Music06PlannerShadowCandidate = Readonly<{
  candidateKey: string;
  type: "MUSIC" | "PODCAST";
  trackName?: string | null;
  artistName?: string | null;
  spotifyTrackId?: string | null;
  primaryArtistId?: string | null;
}>;

export type Music06PlannerInfluenceReason =
  | "TRACK_NEGATIVE_PROJECTION"
  | "ARTIST_NEGATIVE_PROJECTION";

export type Music06PlannerCandidateInfluence = Readonly<{
  candidateKey: string;
  originalMusicRank: number | null;
  shadowMusicRank: number | null;
  requestedMusicRankShift: number;
  actualMusicRankShift: number;
  reasons: readonly Music06PlannerInfluenceReason[];
  explicitPreferenceSuppressed: boolean;
  trackProjectionMatched: boolean;
  artistProjectionMatched: boolean;
}>;

export type Music06PlannerInfluenceCapability = Readonly<{
  recommendationDecision: PolicyDecision;
  plannerEligibilityDecision: PolicyDecision;
  productivelyAuthorized: boolean;
}>;

export type Music06PlannerInfluenceShadowResult = Readonly<{
  mode: "SHADOW_READ_ONLY";
  policyVersion: typeof MUSIC_06_PLANNER_INFLUENCE_SHADOW_POLICY_VERSION;
  capability: Music06PlannerInfluenceCapability;
  config: Music06PlannerInfluenceConfig;
  inputCandidateCount: number;
  outputCandidateCount: number;
  musicCandidateCount: number;
  influencedCandidateCount: number;
  explicitPreferenceSuppressedCount: number;
  trackProjectionInfluenceCount: number;
  artistProjectionInfluenceCount: number;
  maxObservedMusicRankShift: number;
  hypotheticalCandidates: readonly Music06PlannerShadowCandidate[];
  influences: readonly Music06PlannerCandidateInfluence[];
}>;

/**
 * Gate 5 planner influence preview.
 *
 * This function is intentionally pure and shadow-only. It never changes
 * eligibility, never removes candidates, never writes preferences/signals and
 * never invokes the productive planner. It only computes a bounded hypothetical
 * reordering inside the MUSIC subsequence.
 */
export function previewMusic06PlannerInfluenceShadow(input: {
  candidates: readonly Music06PlannerShadowCandidate[];
  projection: Music06NegativeProjectionShadow;
  firstPartyPreferences?: readonly FirstPartyPlaybackPreference[];
  config?: Music06PlannerInfluenceConfig;
}): Music06PlannerInfluenceShadowResult {
  const config = normalizeConfig(
    input.config ?? DEFAULT_MUSIC_06_PLANNER_INFLUENCE_SHADOW_CONFIG,
  );
  const capability = evaluateMusic06PlannerInfluenceCapability();
  const preferences = input.firstPartyPreferences ?? [];
  const explicit = buildExplicitPreferenceIndex(preferences);
  const trackByKey = new Map(input.projection.tracks.map((row) => [row.trackKey, row] as const));
  const artistByKey = new Map(
    input.projection.artists.map((row) => [row.artistKey, row] as const),
  );

  const musicRows: MutableMusicRow[] = [];
  const baseInfluences = new Map<string, Music06PlannerCandidateInfluence>();
  let musicRank = 0;
  let explicitPreferenceSuppressedCount = 0;
  let trackProjectionInfluenceCount = 0;
  let artistProjectionInfluenceCount = 0;

  for (const candidate of input.candidates) {
    if (candidate.type !== "MUSIC") {
      baseInfluences.set(candidate.candidateKey, neutralInfluence(candidate.candidateKey));
      continue;
    }

    const identity = candidateIdentity(candidate);
    const explicitPreferenceSuppressed = hasExplicitPreference(candidate, explicit);
    const trackProjection = identity.trackKey
      ? trackByKey.get(identity.trackKey) ?? null
      : null;
    const artistProjection = identity.artistKey
      ? artistByKey.get(identity.artistKey) ?? null
      : null;

    const reasons: Music06PlannerInfluenceReason[] = [];
    let requestedMusicRankShift = 0;

    if (explicitPreferenceSuppressed) {
      explicitPreferenceSuppressedCount += 1;
    } else {
      if (trackProjection && trackProjectionQualifies(trackProjection, config)) {
        reasons.push("TRACK_NEGATIVE_PROJECTION");
        requestedMusicRankShift += config.track.maxMusicRankShift;
        trackProjectionInfluenceCount += 1;
      }
      if (artistProjection && artistProjectionQualifies(artistProjection, config)) {
        reasons.push("ARTIST_NEGATIVE_PROJECTION");
        requestedMusicRankShift += config.artist.maxMusicRankShift;
        artistProjectionInfluenceCount += 1;
      }
    }

    requestedMusicRankShift = Math.min(
      requestedMusicRankShift,
      config.maxCombinedMusicRankShift,
    );

    const row: MutableMusicRow = {
      candidate,
      originalMusicRank: musicRank,
      requestedMusicRankShift,
      reasons,
      explicitPreferenceSuppressed,
      trackProjectionMatched: trackProjection !== null,
      artistProjectionMatched: artistProjection !== null,
    };
    musicRows.push(row);
    musicRank += 1;
  }

  const hypotheticalMusicRows = applyBoundedMusicRankShift(musicRows);
  const shadowRankByKey = new Map(
    hypotheticalMusicRows.map((row, index) => [row.candidate.candidateKey, index] as const),
  );
  const hypotheticalMusicByRank = hypotheticalMusicRows.map((row) => row.candidate);
  let nextMusicIndex = 0;
  const hypotheticalCandidates = input.candidates.map((candidate) =>
    candidate.type === "MUSIC"
      ? hypotheticalMusicByRank[nextMusicIndex++] ?? candidate
      : candidate,
  );

  for (const row of musicRows) {
    const shadowMusicRank = shadowRankByKey.get(row.candidate.candidateKey) ?? row.originalMusicRank;
    baseInfluences.set(row.candidate.candidateKey, {
      candidateKey: row.candidate.candidateKey,
      originalMusicRank: row.originalMusicRank,
      shadowMusicRank,
      requestedMusicRankShift: row.requestedMusicRankShift,
      actualMusicRankShift: Math.max(0, shadowMusicRank - row.originalMusicRank),
      reasons: row.reasons,
      explicitPreferenceSuppressed: row.explicitPreferenceSuppressed,
      trackProjectionMatched: row.trackProjectionMatched,
      artistProjectionMatched: row.artistProjectionMatched,
    });
  }

  const influences = input.candidates.map(
    (candidate) => baseInfluences.get(candidate.candidateKey) ?? neutralInfluence(candidate.candidateKey),
  );

  return {
    mode: "SHADOW_READ_ONLY",
    policyVersion: MUSIC_06_PLANNER_INFLUENCE_SHADOW_POLICY_VERSION,
    capability,
    config,
    inputCandidateCount: input.candidates.length,
    outputCandidateCount: hypotheticalCandidates.length,
    musicCandidateCount: musicRows.length,
    influencedCandidateCount: influences.filter((row) => row.requestedMusicRankShift > 0).length,
    explicitPreferenceSuppressedCount,
    trackProjectionInfluenceCount,
    artistProjectionInfluenceCount,
    maxObservedMusicRankShift: influences.reduce(
      (max, row) => Math.max(max, row.actualMusicRankShift),
      0,
    ),
    hypotheticalCandidates,
    influences,
  };
}

export function evaluateMusic06PlannerInfluenceCapability(): Music06PlannerInfluenceCapability {
  const lineage = lineageFromRootSource("LASTFM_SCROBBLE");
  const recommendationDecision = policyDecisionForLineage(lineage, "RECOMMENDATION");
  const plannerEligibilityDecision = policyDecisionForLineage(
    lineage,
    "PLANNER_ELIGIBILITY",
  );
  return {
    recommendationDecision,
    plannerEligibilityDecision,
    productivelyAuthorized: recommendationDecision === "ALLOW",
  };
}

type ExplicitPreferenceIndex = Readonly<{
  trackIds: ReadonlySet<string>;
  artistIds: ReadonlySet<string>;
}>;

type MutableMusicRow = {
  candidate: Music06PlannerShadowCandidate;
  originalMusicRank: number;
  requestedMusicRankShift: number;
  reasons: Music06PlannerInfluenceReason[];
  explicitPreferenceSuppressed: boolean;
  trackProjectionMatched: boolean;
  artistProjectionMatched: boolean;
};

function buildExplicitPreferenceIndex(
  preferences: readonly FirstPartyPlaybackPreference[],
): ExplicitPreferenceIndex {
  const trackIds = new Set<string>();
  const artistIds = new Set<string>();
  for (const preference of preferences) {
    if (preference.subjectType === "TRACK") {
      const id = subjectIdentity(preference.subjectKey, FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX);
      if (id) trackIds.add(id);
    } else if (preference.subjectType === "ARTIST") {
      const id = subjectIdentity(preference.subjectKey, FIRST_PARTY_SPOTIFY_ARTIST_SUBJECT_PREFIX);
      if (id) artistIds.add(id);
    }
  }
  return { trackIds, artistIds };
}

function hasExplicitPreference(
  candidate: Music06PlannerShadowCandidate,
  explicit: ExplicitPreferenceIndex,
): boolean {
  const trackId = clean(candidate.spotifyTrackId);
  const artistId = clean(candidate.primaryArtistId);
  return Boolean(
    (trackId && explicit.trackIds.has(trackId)) ||
      (artistId && explicit.artistIds.has(artistId)),
  );
}

function candidateIdentity(candidate: Music06PlannerShadowCandidate): {
  trackKey: string | null;
  artistKey: string | null;
} {
  const trackName = clean(candidate.trackName);
  const artistName = clean(candidate.artistName);
  if (!trackName || !artistName) return { trackKey: null, artistKey: null };
  const normalizedTrack = normalizeMusicIdentityText(trackName);
  const normalizedArtist = normalizeMusicIdentityText(artistName);
  if (!normalizedTrack || !normalizedArtist) return { trackKey: null, artistKey: null };
  return {
    trackKey: `${normalizedArtist}\u0000${normalizedTrack}`,
    artistKey: normalizedArtist,
  };
}

function trackProjectionQualifies(
  row: Music06TrackNegativeProjection,
  config: Music06PlannerInfluenceConfig,
): boolean {
  return (
    row.assessedOccurrenceCount >= config.track.minAssessedOccurrenceCount &&
    row.inferredSkipCount >= config.track.minNegativeOccurrenceCount &&
    row.distinctNegativeDays >= config.track.minDistinctNegativeDays &&
    row.skipRate >= config.track.minSkipRate
  );
}

function artistProjectionQualifies(
  row: Music06ArtistNegativeProjection,
  config: Music06PlannerInfluenceConfig,
): boolean {
  return (
    row.assessedOccurrenceCount >= config.artist.minAssessedOccurrenceCount &&
    row.negativeOccurrenceCount >= config.artist.minNegativeOccurrenceCount &&
    row.distinctTracksNegative >= config.artist.minDistinctTracksNegative &&
    row.distinctNegativeDays >= config.artist.minDistinctNegativeDays &&
    row.skipRate >= config.artist.minSkipRate
  );
}

function applyBoundedMusicRankShift(rows: readonly MutableMusicRow[]): MutableMusicRow[] {
  const ranked = rows.slice();
  const movers = rows
    .filter((row) => row.requestedMusicRankShift > 0)
    .sort((left, right) => right.originalMusicRank - left.originalMusicRank);

  for (const mover of movers) {
    const currentIndex = ranked.findIndex(
      (row) => row.candidate.candidateKey === mover.candidate.candidateKey,
    );
    if (currentIndex < 0) continue;
    const targetIndex = Math.min(
      currentIndex + mover.requestedMusicRankShift,
      ranked.length - 1,
    );
    if (targetIndex === currentIndex) continue;
    const [row] = ranked.splice(currentIndex, 1);
    if (row) ranked.splice(targetIndex, 0, row);
  }

  return ranked;
}

function neutralInfluence(candidateKey: string): Music06PlannerCandidateInfluence {
  return {
    candidateKey,
    originalMusicRank: null,
    shadowMusicRank: null,
    requestedMusicRankShift: 0,
    actualMusicRankShift: 0,
    reasons: [],
    explicitPreferenceSuppressed: false,
    trackProjectionMatched: false,
    artistProjectionMatched: false,
  };
}

function normalizeConfig(config: Music06PlannerInfluenceConfig): Music06PlannerInfluenceConfig {
  assertPositiveInt(config.track.minAssessedOccurrenceCount, "track.minAssessedOccurrenceCount");
  assertPositiveInt(config.track.minNegativeOccurrenceCount, "track.minNegativeOccurrenceCount");
  assertPositiveInt(config.track.minDistinctNegativeDays, "track.minDistinctNegativeDays");
  assertRate(config.track.minSkipRate, "track.minSkipRate");
  assertNonNegativeInt(config.track.maxMusicRankShift, "track.maxMusicRankShift");
  assertPositiveInt(config.artist.minAssessedOccurrenceCount, "artist.minAssessedOccurrenceCount");
  assertPositiveInt(config.artist.minNegativeOccurrenceCount, "artist.minNegativeOccurrenceCount");
  assertPositiveInt(config.artist.minDistinctTracksNegative, "artist.minDistinctTracksNegative");
  assertPositiveInt(config.artist.minDistinctNegativeDays, "artist.minDistinctNegativeDays");
  assertRate(config.artist.minSkipRate, "artist.minSkipRate");
  assertNonNegativeInt(config.artist.maxMusicRankShift, "artist.maxMusicRankShift");
  assertNonNegativeInt(config.maxCombinedMusicRankShift, "maxCombinedMusicRankShift");
  return Object.freeze({
    track: Object.freeze({ ...config.track }),
    artist: Object.freeze({ ...config.artist }),
    maxCombinedMusicRankShift: config.maxCombinedMusicRankShift,
  });
}

function subjectIdentity(subjectKey: string, prefix: string): string | null {
  if (!subjectKey.startsWith(prefix)) return null;
  return clean(subjectKey.slice(prefix.length));
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`MUSIC-06 Gate 5 ${label} must be a positive integer`);
  }
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`MUSIC-06 Gate 5 ${label} must be a non-negative integer`);
  }
}

function assertRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`MUSIC-06 Gate 5 ${label} must be between 0 and 1`);
  }
}
