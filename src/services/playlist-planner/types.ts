/**
 * Domain types for the playlist planner.
 *
 * The planner is deliberately decoupled from Next.js, Prisma, Spotify and
 * Google. It receives plain candidate pools and rules, and returns an ordered
 * plan. Everything else (fetching candidates, resolving durations, writing to
 * Spotify, persisting runs) lives in the orchestration layer.
 */

export type ContentType = "MUSIC" | "PODCAST";

/** A single piece of content that can be placed into a playlist. */
export interface Candidate {
  /** Spotify URI, e.g. "spotify:track:..." or "spotify:episode:...". */
  uri: string;
  type: ContentType;
  title: string;
  /** Artist(s) for music, show/program name for podcasts. */
  subtitle?: string;
  /**
   * Program identifier used to cap episodes per program. For podcasts this is
   * the Spotify show id; for music it is undefined.
   */
  programId?: string;
  durationMs: number;
}

export interface PlaylistRules {
  /** Target total duration, in milliseconds. */
  targetDurationMs: number;
  /** Share of the duration budgeted to podcasts (0–100). */
  podcastPercent: number;
  /** Cyclic sequence of slot types, e.g. [MUSIC, PODCAST, MUSIC, MUSIC, PODCAST]. */
  sequencePattern: ContentType[];
  /** Maximum episodes of the same program allowed in this playlist. */
  maxEpisodesPerProgram: number;
}

export interface PlannedItem extends Candidate {
  position: number;
}

export interface PlanResult {
  items: PlannedItem[];
  /** URIs consumed by this plan — feed these back as `reserved` for the next playlist. */
  usedUris: Set<string>;
  stats: {
    totalDurationMs: number;
    musicDurationMs: number;
    podcastDurationMs: number;
    musicCount: number;
    podcastCount: number;
    /** Slots the pattern asked for but that could not be filled. */
    unfilledSlots: number;
    /** True when the plan stopped because a pool ran dry rather than hitting the target. */
    poolExhausted: boolean;
  };
}
