import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
} from "@/services/music-identity/shadow-resolver-report";

/**
 * #374 Gate 5B: facts are compared for REVIEW ONLY. No outcome here
 * authorizes a RecordingIdentity merge or a productive cooldown decision.
 */
export type Gate5BScrobble = Readonly<{
  trackName: string;
  artistName: string;
  trackMbid: string | null;
}>;

export type Gate5BCandidate = Readonly<{
  providerTrackId: string;
  title: string | null;
  artistName: string | null;
  recordingIdentityId: string;
  providerTrackMbid: string | null;
}>;

export type Gate5BProviderMbidOwner = Readonly<{
  recordingIdentityId: string;
  trackMbid: string | null;
}>;

export type Gate5BDecision =
  | "ABSTAIN_PROVIDER_MBID_MISSING"
  | "ABSTAIN_NO_SCROBBLE_MBID_MATCH"
  | "ABSTAIN_MBID_RECORDING_COLLISION"
  | "ABSTAIN_ARTIST_CONFLICT"
  | "ABSTAIN_TITLE_CONFLICT"
  | "ABSTAIN_VERSION_CONFLICT"
  | "ABSTAIN_METADATA_INCOMPLETE"
  | "REVIEW_MBID_SAME_VERSION"
  | "REVIEW_MBID_REMASTER_STANDARD";

export type Gate5BResult = Readonly<{
  decision: Gate5BDecision;
  evidenceLevel: "REVIEW_ONLY" | "ABSTAIN";
  matchedScrobbleCount: number;
  matchedRecordingIdentityCount: number;
  inferredRecordingEquivalence: false;
  eligibleForProductiveCooldown: false;
}>;

export function normalizeGate5BMbid(value: string | null | undefined): string | null {
  const id = value?.trim().toLowerCase() ?? "";
  // A MusicBrainz identifier must be an actual UUID. Do not trust arbitrary
  // Last.fm strings or inferred track IDs as a recording identifier.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

function result(
  decision: Gate5BDecision,
  matchedScrobbleCount: number,
  matchedRecordingIdentityCount: number,
): Gate5BResult {
  return {
    decision,
    evidenceLevel: decision.startsWith("REVIEW_") ? "REVIEW_ONLY" : "ABSTAIN",
    matchedScrobbleCount,
    matchedRecordingIdentityCount,
    inferredRecordingEquivalence: false,
    eligibleForProductiveCooldown: false,
  };
}

/**
 * Compare a persisted Last.fm MusicBrainz MBID against an exact Spotify
 * TrackProviderRef MBID. This is weaker than a confirmed provider association:
 * Last.fm MBIDs may be unavailable, stale, or refer to different recording
 * granularity. Even a clean one-to-one overlap remains REVIEW_ONLY.
 */
export function compareGate5BMbidEvidence(input: {
  candidate: Gate5BCandidate;
  scrobbles: readonly Gate5BScrobble[];
  mbidOwners: readonly Gate5BProviderMbidOwner[];
}): Gate5BResult {
  const mbid = normalizeGate5BMbid(input.candidate.providerTrackMbid);
  if (!mbid) return result("ABSTAIN_PROVIDER_MBID_MISSING", 0, 0);

  const matched = input.scrobbles.filter(
    (event) => normalizeGate5BMbid(event.trackMbid) === mbid,
  );
  if (matched.length === 0) {
    return result("ABSTAIN_NO_SCROBBLE_MBID_MATCH", 0, 0);
  }

  const ownerIdentities = new Set(
    input.mbidOwners
      .filter((owner) => normalizeGate5BMbid(owner.trackMbid) === mbid)
      .map((owner) => owner.recordingIdentityId),
  );
  // This must be based on ALL persisted refs with this MBID in the user's
  // provider namespace, not only this target's refs.
  if (
    ownerIdentities.size !== 1 ||
    !ownerIdentities.has(input.candidate.recordingIdentityId)
  ) {
    return result(
      "ABSTAIN_MBID_RECORDING_COLLISION",
      matched.length,
      ownerIdentities.size,
    );
  }

  const targetArtist = normalizeMusicIdentityText(input.candidate.artistName);
  const targetTitle = deriveBaseTitleSignal(input.candidate.title);
  if (!targetArtist || !targetTitle) {
    return result("ABSTAIN_METADATA_INCOMPLETE", matched.length, 1);
  }

  let remasterTransition = false;
  for (const event of matched) {
    const artist = normalizeMusicIdentityText(event.artistName);
    const title = deriveBaseTitleSignal(event.trackName);
    if (!artist || !title) {
      return result("ABSTAIN_METADATA_INCOMPLETE", matched.length, 1);
    }
    if (artist !== targetArtist) {
      return result("ABSTAIN_ARTIST_CONFLICT", matched.length, 1);
    }
    if (title !== targetTitle) {
      return result("ABSTAIN_TITLE_CONFLICT", matched.length, 1);
    }

    const eventVersion = classifyShadowResolverVersion({ trackName: event.trackName });
    const candidateVersion = classifyShadowResolverVersion({
      trackName: input.candidate.title,
    });
    if (eventVersion === "UNKNOWN" || candidateVersion === "UNKNOWN") {
      return result("ABSTAIN_METADATA_INCOMPLETE", matched.length, 1);
    }
    const versionsEqual = candidateVersion === eventVersion;
    const allowedRemasterTransition =
      (candidateVersion === "REMASTER" && eventVersion === "STANDARD") ||
      (candidateVersion === "STANDARD" && eventVersion === "REMASTER");
    if (!versionsEqual && !allowedRemasterTransition) {
      return result("ABSTAIN_VERSION_CONFLICT", matched.length, 1);
    }
    if (allowedRemasterTransition) remasterTransition = true;
  }

  return result(
    remasterTransition ? "REVIEW_MBID_REMASTER_STANDARD" : "REVIEW_MBID_SAME_VERSION",
    matched.length,
    1,
  );
}
