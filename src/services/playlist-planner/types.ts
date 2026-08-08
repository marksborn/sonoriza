/**
 * Domain types for the playlist planner.
 *
 * The planner is deliberately decoupled from Next.js, Prisma, Spotify and
 * Google. It receives plain candidate pools and rules, and returns an ordered
 * plan. Everything else lives in the orchestration layer.
 */

export type ContentType = "MUSIC" | "PODCAST";
export type CompositionMode = "PROPORTION" | "SEQUENCE";
export type SequenceStopReason =
  | "TARGET_REACHED"
  | "NO_CANDIDATE_FOR_SLOT"
  | "NO_FITTING_CANDIDATE"
  | "INVALID_PATTERN";

export interface Candidate {
  uri: string;
  type: ContentType;
  title: string;
  subtitle?: string;
  programId?: string;
  durationMs: number;
  originalDurationMs?: number;
  resumePositionMs?: number;
  playbackPositionKnown?: boolean;
}

export interface PlaylistRules {
  targetDurationMs: number;
  /** Explicit composition semantics. Existing destinations migrate to PROPORTION. */
  compositionMode: CompositionMode;
  /** Active as a rule only in PROPORTION mode. */
  podcastPercent: number;
  /** Active as a rule only in SEQUENCE mode. */
  sequencePattern: ContentType[];
  maxEpisodesPerProgram: number;
  maxPodcastDurationMs?: number | null;
}

export interface PlannedItem extends Candidate {
  position: number;
}

export interface PlanResult {
  items: PlannedItem[];
  usedUris: Set<string>;
  stats: {
    compositionMode: CompositionMode;
    totalDurationMs: number;
    musicDurationMs: number;
    podcastDurationMs: number;
    musicCount: number;
    podcastCount: number;
    actualPodcastPercent: number;
    /** Retained for compatibility; active as a rule only in PROPORTION mode. */
    requestedPodcastPercent: number;
    podcastShortfallMs: number;
    musicShortfallMs: number;
    /** Retained for compatibility; zero and non-gating in SEQUENCE mode. */
    mixDeviationPoints: number;
    /** Retained alias. In SEQUENCE it mirrors sequenceQualityPassed, not a percentage gate. */
    mixQualityPassed: boolean;
    /** Canonical mode-aware composition gate. */
    compositionQualityPassed: boolean;
    unfilledSlots: number;
    poolExhausted: boolean;
    podcastIdentityMissingCount: number;
    podcastDurationExceededCount: number;
    sequenceSlotsRequested: number;
    sequenceSlotsFilled: number;
    sequenceUnfilledSlots: number;
    completedCycles: number;
    finalPartialCycleSlots: number;
    stoppedAtPatternIndex: number | null;
    sequenceQualityPassed: boolean | null;
    sequenceStopReason: SequenceStopReason | null;
  };
}
