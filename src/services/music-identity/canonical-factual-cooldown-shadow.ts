import { normalizeIsrcEvidence } from "./contracts";
import { lastFmMusicIdentityKey } from "@/jobs/music-repeat-runtime";

/**
 * #374 Gate 5A: a read-only comparison, NOT an eligibility decision.
 * Last.fm titles do not become canonical recording evidence by text similarity.
 * In particular, matching ISRC without a provider-linked scrobble is review-only.
 */
export type Gate5AFactualEvent = Readonly<{
  trackName: string;
  artistName: string;
  spotifyTrackId: string | null;
  isrc: string | null;
  trackMbid: string | null;
}>;

export type Gate5APublishedTrack = Readonly<{
  spotifyTrackId: string | null;
  trackName: string | null;
  artistName: string | null;
}>;

export type Gate5AProviderRef = Readonly<{
  providerTrackId: string;
  recordingIdentityId: string;
  matchReason: string;
  confidenceBasisPoints: number;
  isrc: string | null;
  trackMbid: string | null;
}>;

export type Gate5ACanonicalDecision =
  | "EXACT_PROVIDER_REF"
  | "STRONG_SAME_RECORDING"
  | "REVIEW_WEAK_SAME_RECORDING"
  | "REVIEW_ISRC_OR_MBID_ONLY"
  | "ABSTAIN_NO_CANONICAL_EVIDENCE";

export type Gate5AComparison = Readonly<{
  legacyTextMatch: boolean;
  canonical: Gate5ACanonicalDecision;
  canonicalIsAdditionalCooldown: boolean;
}>;

const STRONG_ASSOCIATION_REASONS = new Set([
  "EXACT_PROVIDER_ALIAS",
  "SAME_RECORDING_HIGH_CONFIDENCE",
]);

function strongRecordingPair(a: Gate5AProviderRef, b: Gate5AProviderRef): boolean {
  if (a.recordingIdentityId !== b.recordingIdentityId) return false;
  if (
    !(
      (STRONG_ASSOCIATION_REASONS.has(a.matchReason) && a.confidenceBasisPoints >= 9_000) ||
      (STRONG_ASSOCIATION_REASONS.has(b.matchReason) && b.confidenceBasisPoints >= 9_000)
    )
  ) {
    return false;
  }
  const aIsrc = normalizeIsrcEvidence(a.isrc);
  const bIsrc = normalizeIsrcEvidence(b.isrc);
  const aMbid = a.trackMbid?.trim().toLowerCase() ?? "";
  const bMbid = b.trackMbid?.trim().toLowerCase() ?? "";
  // An already-shared canonical recording is necessary but not enough;
  // require compatible strong identifiers on both provider refs.
  return Boolean((aIsrc && aIsrc === bIsrc) || (aMbid && aMbid === bMbid));
}

export function compareGate5AFactualCooldown(input: {
  published: Gate5APublishedTrack;
  events: readonly Gate5AFactualEvent[];
  refs: readonly Gate5AProviderRef[];
}): Gate5AComparison {
  const publishedKey = lastFmMusicIdentityKey(
    input.published.trackName,
    input.published.artistName,
  );
  const legacyTextMatch = Boolean(
    publishedKey &&
    input.events.some(
      (event) =>
        lastFmMusicIdentityKey(event.trackName, event.artistName) === publishedKey,
    ),
  );
  const spotifyTrackId = input.published.spotifyTrackId?.trim() || null;
  const refById = new Map(input.refs.map((ref) => [ref.providerTrackId, ref]));
  const candidateRef = spotifyTrackId ? refById.get(spotifyTrackId) : undefined;
  let weakSameRecording = false;
  let identifierOnly = false;
  let strongSameRecording = false;
  let exactProviderRef = false;

  for (const event of input.events) {
    const factualTrackId = event.spotifyTrackId?.trim() || null;

    // Only an ID contained in the factual Last.fm event can create a direct
    // provider join. Never join a scrobble to Spotify by normalized text.
    if (spotifyTrackId && factualTrackId && spotifyTrackId === factualTrackId) {
      exactProviderRef = true;
      continue;
    }

    const eventRef = factualTrackId ? refById.get(factualTrackId) : undefined;
    if (candidateRef && eventRef) {
      if (strongRecordingPair(candidateRef, eventRef)) {
        strongSameRecording = true;
        continue;
      }
      if (candidateRef.recordingIdentityId === eventRef.recordingIdentityId) {
        weakSameRecording = true;
      }
    }

    if (candidateRef) {
      const candidateIsrc = normalizeIsrcEvidence(candidateRef.isrc);
      const scrobbleIsrc = normalizeIsrcEvidence(event.isrc);
      const candidateMbid = candidateRef.trackMbid?.trim().toLowerCase() || null;
      const scrobbleMbid = event.trackMbid?.trim().toLowerCase() || null;
      if (
        (candidateIsrc && scrobbleIsrc && candidateIsrc === scrobbleIsrc) ||
        (candidateMbid && scrobbleMbid && candidateMbid === scrobbleMbid)
      ) {
        identifierOnly = true;
      }
    }
  }

  const canonical: Gate5ACanonicalDecision = exactProviderRef
    ? "EXACT_PROVIDER_REF"
    : strongSameRecording
      ? "STRONG_SAME_RECORDING"
      : weakSameRecording
        ? "REVIEW_WEAK_SAME_RECORDING"
        : identifierOnly
          ? "REVIEW_ISRC_OR_MBID_ONLY"
          : "ABSTAIN_NO_CANONICAL_EVIDENCE";

  return {
    legacyTextMatch,
    canonical,
    canonicalIsAdditionalCooldown:
      !legacyTextMatch && (exactProviderRef || strongSameRecording),
  };
}
