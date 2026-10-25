import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import {
  classifyShadowResolverVersion,
  deriveBaseTitleSignal,
} from "@/services/music-identity/shadow-resolver-report";

export type Gate5CMusicBrainzRecording = Readonly<{
  id: string;
  title: string;
  durationMs: number | null;
  artistNames: readonly string[];
}>;

export type Gate5CProviderTrack = Readonly<{
  title: string;
  artistName: string;
  durationMs: number;
  isrc: string | null;
  linkedFromTrackId: string | null;
}>;

export type Gate5CDecision =
  | "ABSTAIN_INVALID_ISRC"
  | "ABSTAIN_RELINKED_TRACK"
  | "ABSTAIN_ISRC_NOT_FOUND_404"
  | "ABSTAIN_ZERO_RECORDINGS"
  | "ABSTAIN_MULTIPLE_MBIDS"
  | "ABSTAIN_INVALID_MUSICBRAINZ_MBID"
  | "ABSTAIN_TITLE_MISMATCH"
  | "ABSTAIN_ARTIST_MISMATCH"
  | "ABSTAIN_VERSION_CONFLICT"
  | "ABSTAIN_DURATION_MISSING"
  | "ABSTAIN_DURATION_MISMATCH"
  | "REVIEW_TEXTUAL_ALIAS"
  | "REVIEW_SINGLE_MBID"
  | "REVIEW_STANDARD_REMASTER";

export type Gate5CDecisionResult = Readonly<{
  decision: Gate5CDecision;
  mbids: string[];
  recordingCount: number;
  durationDeltaMs: number | null;
  reviewOnly: true;
  recordingIdentityWrites: false;
  productiveCooldownEligible: false;
}>;

export function gate5CNormalizeIsrc(value: string | null | undefined): string | null {
  const code = value?.replace(/[-\s]/g, "").trim().toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(code) ? code : null;
}

export function gate5CNormalizeMbid(value: string | null | undefined): string | null {
  const mbid = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mbid)
    ? mbid
    : null;
}

function result(
  decision: Gate5CDecision,
  mbids: string[],
  recordingCount: number,
  durationDeltaMs: number | null = null,
): Gate5CDecisionResult {
  return {
    decision, mbids, recordingCount, durationDeltaMs,
    reviewOnly: true,
    recordingIdentityWrites: false,
    productiveCooldownEligible: false,
  };
}

/**
 * MusicBrainz ISRC associations are hints, never a proof of scrobble identity.
 * Even a single MBID with aligned artist/title/duration is REVIEW_ONLY.
 */
export function evaluateGate5CIsrcMbid(input: {
  spotify: Gate5CProviderTrack;
  lookup: { kind: "NOT_FOUND" } | { kind: "FOUND"; recordings: readonly Gate5CMusicBrainzRecording[] };
}): Gate5CDecisionResult {
  if (!gate5CNormalizeIsrc(input.spotify.isrc)) {
    return result("ABSTAIN_INVALID_ISRC", [], 0);
  }
  if (input.spotify.linkedFromTrackId) {
    return result("ABSTAIN_RELINKED_TRACK", [], 0);
  }
  if (input.lookup.kind === "NOT_FOUND") {
    return result("ABSTAIN_ISRC_NOT_FOUND_404", [], 0);
  }

  const recordings = input.lookup.recordings;
  if (recordings.length === 0) {
    return result("ABSTAIN_ZERO_RECORDINGS", [], 0);
  }
  const mbids = [...new Set(recordings.map((recording) => gate5CNormalizeMbid(recording.id)))];
  if (mbids.some((id) => id === null)) {
    return result("ABSTAIN_INVALID_MUSICBRAINZ_MBID", [], recordings.length);
  }
  const validMbids = mbids.filter((mbid): mbid is string => mbid !== null).sort();
  if (validMbids.length !== 1) {
    return result("ABSTAIN_MULTIPLE_MBIDS", validMbids, recordings.length);
  }

  const recording = recordings[0];
  if (!recording) return result("ABSTAIN_ZERO_RECORDINGS", [], 0);
  const providerTitle = deriveBaseTitleSignal(input.spotify.title);
  const recordingTitle = deriveBaseTitleSignal(recording.title);
  // Gate 5D.7: spacing is only a review hint in this manual shadow probe.
  // Keep the shared canonical title signal strict; never reuse the factual
  // cooldown key as evidence of recording equivalence.
  const textualAlias = Boolean(
    providerTitle && recordingTitle && providerTitle !== recordingTitle &&
    providerTitle.replace(/\s/g, "") === recordingTitle.replace(/\s/g, ""),
  );
  if (!providerTitle || !recordingTitle || (providerTitle !== recordingTitle && !textualAlias)) {
    return result("ABSTAIN_TITLE_MISMATCH", validMbids, recordings.length);
  }
  const artist = normalizeMusicIdentityText(input.spotify.artistName);
  const recordingArtists = recording.artistNames.map((name) => normalizeMusicIdentityText(name));
  if (!artist || !recordingArtists.includes(artist)) {
    return result("ABSTAIN_ARTIST_MISMATCH", validMbids, recordings.length);
  }
  const providerVersion = classifyShadowResolverVersion({ trackName: input.spotify.title });
  const mbVersion = classifyShadowResolverVersion({ trackName: recording.title });
  const compatibleRemaster =
    (providerVersion === "REMASTER" && mbVersion === "STANDARD") ||
    (providerVersion === "STANDARD" && mbVersion === "REMASTER");
  if (
    providerVersion === "UNKNOWN" || mbVersion === "UNKNOWN" ||
    (providerVersion !== mbVersion && !compatibleRemaster)
  ) {
    return result("ABSTAIN_VERSION_CONFLICT", validMbids, recordings.length);
  }
  if (
    !Number.isFinite(input.spotify.durationMs) || input.spotify.durationMs <= 0 ||
    recording.durationMs === null || !Number.isFinite(recording.durationMs) ||
    recording.durationMs <= 0
  ) {
    return result("ABSTAIN_DURATION_MISSING", validMbids, recordings.length);
  }

  const deltaMs = Math.abs(input.spotify.durationMs - recording.durationMs);
  if (deltaMs > 5_000) {
    return result("ABSTAIN_DURATION_MISMATCH", validMbids, recordings.length, deltaMs);
  }

  return result(
    textualAlias ? "REVIEW_TEXTUAL_ALIAS" :
      compatibleRemaster ? "REVIEW_STANDARD_REMASTER" : "REVIEW_SINGLE_MBID",
    validMbids,
    recordings.length,
    deltaMs,
  );
}
