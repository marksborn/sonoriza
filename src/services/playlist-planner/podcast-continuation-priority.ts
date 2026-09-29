import type { Candidate } from "./types";

export type PodcastContinuationListeningState = Readonly<{
  spotifyEpisodeId: string;
  status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  lastObservedAt: Date | null;
  firstProgressObservedAt: Date | null;
}>;

export type PodcastContinuationProjection = Readonly<{
  candidates: Candidate[];
  continuationCandidateCount: number;
  promotedEpisodeIds: string[];
  selectedEpisodeId: string | null;
  movedCount: number;
}>;

/**
 * PODCAST-09 Gate 2 pure projection.
 *
 * This helper has no runtime wiring. It only projects how already-eligible
 * PODCAST candidates would be ordered if IN_PROGRESS continuation were
 * promoted. Eligibility, cadence, expiry, source scope and duration fitting
 * remain owned by the existing upstream/downstream seams.
 *
 * Ordering contract inside the PODCAST subsequence:
 * 1. promotable IN_PROGRESS episodes first;
 * 2. most recently observed continuation first;
 * 3. most recent first progress as fallback;
 * 4. stable original order as final tie-break;
 * 5. every non-continuation podcast keeps its original relative order.
 *
 * Non-PODCAST candidates keep their exact positions, so this projection cannot
 * change a MUSIC/PODCAST composition pattern even if it is accidentally given
 * a mixed pool.
 *
 * Missing episode identity is fail-closed: such a candidate is never promoted.
 */
export function projectPodcastContinuationPriority(input: {
  candidates: readonly Candidate[];
  listeningStates?: readonly PodcastContinuationListeningState[];
}): PodcastContinuationProjection {
  const listeningStateByEpisodeId = new Map(
    (input.listeningStates ?? []).map((state) => [state.spotifyEpisodeId, state] as const),
  );

  const original = [...input.candidates];
  const podcastCandidates = original.filter((candidate) => candidate.type === "PODCAST");
  const continuation = podcastCandidates.flatMap((candidate, podcastIndex) => {
    if (
      candidate.podcastListeningStatus !== "IN_PROGRESS" ||
      !candidate.spotifyEpisodeId
    ) {
      return [];
    }

    const state = listeningStateByEpisodeId.get(candidate.spotifyEpisodeId) ?? null;
    return [
      {
        candidate,
        podcastIndex,
        episodeId: candidate.spotifyEpisodeId,
        lastObservedAt: state?.lastObservedAt ?? null,
        firstProgressObservedAt:
          state?.firstProgressObservedAt ?? candidate.podcastFirstProgressObservedAt ?? null,
      },
    ];
  });

  if (continuation.length === 0) {
    return {
      candidates: original,
      continuationCandidateCount: 0,
      promotedEpisodeIds: [],
      selectedEpisodeId: null,
      movedCount: 0,
    };
  }

  continuation.sort((left, right) => {
    const lastObserved = compareDateDesc(left.lastObservedAt, right.lastObservedAt);
    if (lastObserved !== 0) return lastObserved;

    const firstProgress = compareDateDesc(
      left.firstProgressObservedAt,
      right.firstProgressObservedAt,
    );
    if (firstProgress !== 0) return firstProgress;

    return left.podcastIndex - right.podcastIndex;
  });

  const continuationCandidates = new Set(continuation.map((entry) => entry.candidate));
  const projectedPodcasts = [
    ...continuation.map((entry) => entry.candidate),
    ...podcastCandidates.filter((candidate) => !continuationCandidates.has(candidate)),
  ];
  let nextPodcastIndex = 0;
  const projected = original.map((candidate) =>
    candidate.type === "PODCAST"
      ? projectedPodcasts[nextPodcastIndex++]!
      : candidate,
  );
  const movedCount = projected.reduce(
    (count, candidate, index) => count + (original[index] === candidate ? 0 : 1),
    0,
  );
  const promotedEpisodeIds = continuation.map((entry) => entry.episodeId);

  return {
    candidates: projected,
    continuationCandidateCount: continuation.length,
    promotedEpisodeIds,
    selectedEpisodeId: promotedEpisodeIds[0] ?? null,
    movedCount,
  };
}

function compareDateDesc(left: Date | null, right: Date | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right.getTime() - left.getTime();
}
