import { parseSequencePattern } from "@/services/playlist-planner";

export type PodcastRefreshTarget = Readonly<{
  compositionMode: "PROPORTION" | "SEQUENCE";
  podcastPercent: number;
  sequencePattern: unknown;
}>;

/**
 * Returns whether a target can actually select podcast content.
 *
 * PODCAST-07's proactive factual playback refresh runs before the base planner,
 * so it must not spend provider quota for a target that cannot possibly emit a
 * podcast. SEQUENCE is authoritative over podcastPercent: a MUSIC-only sequence
 * remains music-only even if a legacy percentage is still persisted.
 */
export function targetMaySelectPodcast(target: PodcastRefreshTarget): boolean {
  if (target.compositionMode === "SEQUENCE") {
    return parseSequencePattern(target.sequencePattern).includes("PODCAST");
  }

  return target.podcastPercent > 0;
}

export function scopedTargetsMaySelectPodcast(
  targets: readonly PodcastRefreshTarget[],
): boolean {
  return targets.some(targetMaySelectPodcast);
}
