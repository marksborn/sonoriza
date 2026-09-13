import type {
  IncrementalCandidateSource,
  IncrementalSourceBatch,
} from "@/jobs/incremental-planning";

import {
  applyPodcast07SavedEpisodesCandidates,
  podcast07NeedsFullSavedTraversal,
  type Podcast07SourceDescriptor,
} from "./podcast-07-runtime";
import type { PodcastShowPolicyRuntimeSnapshot } from "./podcast-show-policy-history";

/**
 * Gate 7 adapter around the existing Spotify SAVED_EPISODES cursor.
 *
 * The underlying reader remains the single owner of provider access and factual
 * EpisodeListeningState observation. ACTIVE Gate 7 only changes when that cursor
 * is exhausted: the full saved set is collected once so per-show ordering and
 * SAVED_ONLY overrides can be resolved without catalog reads.
 */
export function wrapPodcast07SavedEpisodesSource<TSource extends IncrementalCandidateSource>(
  input: {
    source: TSource;
    sourceConfig: Podcast07SourceDescriptor;
    showPolicies: ReadonlyMap<string, PodcastShowPolicyRuntimeSnapshot>;
  },
): TSource {
  if (!podcast07NeedsFullSavedTraversal(input.sourceConfig.id)) {
    return input.source;
  }

  let delivered = false;
  const cursor = input.source;

  const wrapped: IncrementalCandidateSource = {
    id: cursor.id,
    label: cursor.label,
    kind: cursor.kind,
    get done() {
      return delivered;
    },
    readNext: async (): Promise<IncrementalSourceBatch> => {
      if (delivered) return { candidates: [], done: true };

      const accumulated: IncrementalSourceBatch = {
        candidates: [],
        done: false,
      };
      while (!cursor.done) {
        const batch = await cursor.readNext();
        accumulated.candidates.push(...batch.candidates);
        accumulated.playbackPositionMissingCount =
          (accumulated.playbackPositionMissingCount ?? 0) +
          (batch.playbackPositionMissingCount ?? 0);
        accumulated.fullyPlayedSkippedCount =
          (accumulated.fullyPlayedSkippedCount ?? 0) +
          (batch.fullyPlayedSkippedCount ?? 0);
        accumulated.podcastNotStartedCount =
          (accumulated.podcastNotStartedCount ?? 0) +
          (batch.podcastNotStartedCount ?? 0);
        accumulated.podcastInProgressCount =
          (accumulated.podcastInProgressCount ?? 0) +
          (batch.podcastInProgressCount ?? 0);
        accumulated.podcastCompletedCount =
          (accumulated.podcastCompletedCount ?? 0) +
          (batch.podcastCompletedCount ?? 0);
        accumulated.genericPodcastSuppressedCount =
          (accumulated.genericPodcastSuppressedCount ?? 0) +
          (batch.genericPodcastSuppressedCount ?? 0);
      }

      delivered = true;
      return {
        ...accumulated,
        candidates: applyPodcast07SavedEpisodesCandidates({
          candidates: accumulated.candidates,
          source: input.sourceConfig,
          showPolicies: input.showPolicies,
        }),
        done: true,
      };
    },
  };

  return wrapped as TSource;
}
