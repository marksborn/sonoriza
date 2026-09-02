import {
  policyDecisionForLineage,
  type PolicyDecision,
  type PolicyUse,
} from "@/services/data-policy";
import type { Candidate } from "@/services/playlist-planner";

import {
  lineageForFirstPartyPreference,
  type FirstPartyPlaybackPreference,
  type PlaybackPreferencePolicy,
} from "./first-party-playback-preference";

export const FIRST_PARTY_PLANNER_POLICY_VERSION =
  "gate5b-first-party-planner-v1" as const;

export const FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX = "spotify:track:";
export const FIRST_PARTY_SPOTIFY_ARTIST_SUBJECT_PREFIX = "spotify:artist:";

export type FirstPartyPlannerPreferenceEvidence = Readonly<{
  policyVersion: typeof FIRST_PARTY_PLANNER_POLICY_VERSION;
  inputCandidateCount: number;
  outputCandidateCount: number;
  loadedPreferenceCount: number;
  applicablePreferenceCount: number;
  unsupportedPreferenceCount: number;
  capabilityBlockedPreferenceCount: number;
  excludedCandidateCount: number;
  preferredCandidateCount: number;
  reducedCandidateCount: number;
  normalCandidateCount: number;
  trackPreferenceMatchCount: number;
  artistPreferenceMatchCount: number;
}>;

export type FirstPartyPlannerPreferenceResult = Readonly<{
  candidates: Candidate[];
  evidence: FirstPartyPlannerPreferenceEvidence;
}>;

type SupportedPreference = Readonly<{
  subjectType: "TRACK" | "ARTIST";
  subjectId: string;
  policy: PlaybackPreferencePolicy;
}>;

type CandidatePreference = Readonly<{
  policy: PlaybackPreferencePolicy | null;
  trackMatched: boolean;
  artistMatched: boolean;
}>;

/**
 * Gate 5B first-party planner bridge.
 *
 * Only explicit TRACK/ARTIST identities are productive in this cut. The
 * subjectKey contains an operational Spotify identity, but the instruction
 * itself remains FIRST_PARTY. We deliberately do not infer identities from
 * Spotify listening behavior, artist affinity, Saved Tracks or title text.
 *
 * VERSION_TRAIT, DISCOVERY and REPEAT remain persisted first-party preferences
 * but are intentionally non-productive here until each has a provider-neutral
 * semantic implementation. In particular, Gate 5B does not reuse the existing
 * Spotify-metadata LIVE classifier.
 */
export function applyFirstPartyPlaybackPreferencesToMusicCandidates(
  candidates: readonly Candidate[],
  preferences: readonly FirstPartyPlaybackPreference[],
): FirstPartyPlannerPreferenceResult {
  const trackPolicies = new Map<string, PlaybackPreferencePolicy>();
  const artistPolicies = new Map<string, PlaybackPreferencePolicy>();
  let applicablePreferenceCount = 0;
  let unsupportedPreferenceCount = 0;
  let capabilityBlockedPreferenceCount = 0;

  for (const preference of preferences) {
    const supported = supportedPreference(preference);
    if (!supported) {
      unsupportedPreferenceCount += 1;
      continue;
    }

    const policyUse = plannerUseForPolicy(supported.policy);
    const decision = plannerDecision(preference, policyUse);
    if (decision !== "ALLOW") {
      capabilityBlockedPreferenceCount += 1;
      continue;
    }

    applicablePreferenceCount += 1;
    if (supported.subjectType === "TRACK") {
      trackPolicies.set(supported.subjectId, supported.policy);
    } else {
      artistPolicies.set(supported.subjectId, supported.policy);
    }
  }

  const ranked: Array<{
    candidate: Candidate;
    originalIndex: number;
    bucket: number;
  }> = [];
  let excludedCandidateCount = 0;
  let preferredCandidateCount = 0;
  let reducedCandidateCount = 0;
  let normalCandidateCount = 0;
  let trackPreferenceMatchCount = 0;
  let artistPreferenceMatchCount = 0;

  candidates.forEach((candidate, originalIndex) => {
    const effective = effectiveCandidatePreference(
      candidate,
      trackPolicies,
      artistPolicies,
    );

    if (effective.trackMatched) trackPreferenceMatchCount += 1;
    if (effective.artistMatched) artistPreferenceMatchCount += 1;

    if (effective.policy === "EXCLUDED") {
      excludedCandidateCount += 1;
      return;
    }

    const bucket = preferenceBucket(effective.policy);
    if (effective.policy === "PREFERRED") preferredCandidateCount += 1;
    else if (effective.policy === "REDUCED") reducedCandidateCount += 1;
    else normalCandidateCount += 1;

    ranked.push({ candidate, originalIndex, bucket });
  });

  ranked.sort((a, b) => a.bucket - b.bucket || a.originalIndex - b.originalIndex);

  return {
    candidates: ranked.map((row) => row.candidate),
    evidence: {
      policyVersion: FIRST_PARTY_PLANNER_POLICY_VERSION,
      inputCandidateCount: candidates.length,
      outputCandidateCount: ranked.length,
      loadedPreferenceCount: preferences.length,
      applicablePreferenceCount,
      unsupportedPreferenceCount,
      capabilityBlockedPreferenceCount,
      excludedCandidateCount,
      preferredCandidateCount,
      reducedCandidateCount,
      normalCandidateCount,
      trackPreferenceMatchCount,
      artistPreferenceMatchCount,
    },
  };
}

export function firstPartySpotifyTrackSubjectKey(spotifyTrackId: string): string {
  return `${FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX}${requiredIdentity(spotifyTrackId, "track")}`;
}

export function firstPartySpotifyArtistSubjectKey(spotifyArtistId: string): string {
  return `${FIRST_PARTY_SPOTIFY_ARTIST_SUBJECT_PREFIX}${requiredIdentity(spotifyArtistId, "artist")}`;
}

function supportedPreference(
  preference: FirstPartyPlaybackPreference,
): SupportedPreference | null {
  if (preference.subjectType === "TRACK") {
    const subjectId = identityFromKey(
      preference.subjectKey,
      FIRST_PARTY_SPOTIFY_TRACK_SUBJECT_PREFIX,
    );
    return subjectId
      ? { subjectType: "TRACK", subjectId, policy: preference.policy }
      : null;
  }

  if (preference.subjectType === "ARTIST") {
    const subjectId = identityFromKey(
      preference.subjectKey,
      FIRST_PARTY_SPOTIFY_ARTIST_SUBJECT_PREFIX,
    );
    return subjectId
      ? { subjectType: "ARTIST", subjectId, policy: preference.policy }
      : null;
  }

  return null;
}

function plannerDecision(
  preference: FirstPartyPlaybackPreference,
  use: PolicyUse,
): PolicyDecision {
  return policyDecisionForLineage(
    lineageForFirstPartyPreference(preference.source),
    use,
  );
}

function plannerUseForPolicy(policy: PlaybackPreferencePolicy): PolicyUse {
  return policy === "EXCLUDED" ? "PLANNER_ELIGIBILITY" : "RECOMMENDATION";
}

function effectiveCandidatePreference(
  candidate: Candidate,
  trackPolicies: ReadonlyMap<string, PlaybackPreferencePolicy>,
  artistPolicies: ReadonlyMap<string, PlaybackPreferencePolicy>,
): CandidatePreference {
  if (candidate.type !== "MUSIC") {
    return { policy: null, trackMatched: false, artistMatched: false };
  }

  const trackId = candidate.spotifyTrackId?.trim() || null;
  const artistId = candidate.primaryArtistId?.trim() || null;
  const trackPolicy = trackId ? trackPolicies.get(trackId) ?? null : null;
  const artistPolicy = artistId ? artistPolicies.get(artistId) ?? null : null;

  // EXCLUDED is a hard veto across all matching explicit preferences. For the
  // remaining policies, the more specific TRACK instruction wins over ARTIST;
  // this lets an explicit TRACK=NORMAL restore one track from ARTIST=REDUCED.
  const policy =
    trackPolicy === "EXCLUDED" || artistPolicy === "EXCLUDED"
      ? "EXCLUDED"
      : trackPolicy ?? artistPolicy;

  return {
    policy,
    trackMatched: trackPolicy !== null,
    artistMatched: artistPolicy !== null,
  };
}

function preferenceBucket(policy: PlaybackPreferencePolicy | null): number {
  if (policy === "PREFERRED") return 0;
  if (policy === "REDUCED") return 2;
  return 1;
}

function identityFromKey(subjectKey: string, prefix: string): string | null {
  if (!subjectKey.startsWith(prefix)) return null;
  const identity = subjectKey.slice(prefix.length).trim();
  return identity || null;
}

function requiredIdentity(value: string, label: string): string {
  const identity = value.trim();
  if (!identity) throw new Error(`First-party Spotify ${label} identity is required`);
  return identity;
}
