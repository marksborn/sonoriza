import {
  classifyTrackVersion,
  type TrackVersionClassification,
  type TrackVersionClassificationReason,
} from "./track-version-preference";

export const TRACK_VERSION_SCORE_POLICY = {
  version: "music-version-v1",
  studioOrStandardMultiplier: 1,
  unknownMultiplier: 1,
  liveMultiplier: 0.9,
  rule: "PENALIZE_LIVE_WITHOUT_BLOCKING",
} as const;

export type TrackVersionScoreAdjustment = {
  policyVersion: typeof TRACK_VERSION_SCORE_POLICY.version;
  classification: TrackVersionClassification;
  reason: TrackVersionClassificationReason;
  source: "TRACK_NAME" | "ALBUM_NAME" | null;
  matchedText: string | null;
  multiplier: number;
  scoreBefore: number;
  scoreAfter: number;
  scoreDelta: number;
};

export function trackVersionScoreMultiplier(
  classification: TrackVersionClassification,
): number {
  if (classification === "LIVE") return TRACK_VERSION_SCORE_POLICY.liveMultiplier;
  if (classification === "UNKNOWN") return TRACK_VERSION_SCORE_POLICY.unknownMultiplier;
  return TRACK_VERSION_SCORE_POLICY.studioOrStandardMultiplier;
}

export function adjustTrackVersionScore(input: {
  score: number;
  trackName: string;
  albumName?: string | null;
}): TrackVersionScoreAdjustment {
  if (!Number.isFinite(input.score)) throw new Error("score must be finite");

  const version = classifyTrackVersion({
    trackName: input.trackName,
    albumName: input.albumName ?? null,
  });
  const multiplier = trackVersionScoreMultiplier(version.classification);
  const scoreAfter = round3(input.score * multiplier);

  return {
    policyVersion: TRACK_VERSION_SCORE_POLICY.version,
    classification: version.classification,
    reason: version.reason,
    source: version.source,
    matchedText: version.matchedText,
    multiplier,
    scoreBefore: round3(input.score),
    scoreAfter,
    scoreDelta: round3(scoreAfter - input.score),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
