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
 * This helper has no runtime wiring. It only projects how the already-eligible
 * podcast pool would be ordered if IN_PROGRESS continuation were promoted.
 * Eligibility, cadence, expiry, source scope and duration fitting remain owned
 * by the existing upstream/downstream seams.
 *
 * Ordering contract:
 * 1. promotable IN_PROGRESS episodes first;
 * 2. most recently observed continuation first;
 * 3. most recent first progress as fallback;
 * 4. stable original order as final tie-break;
 * 5. every non-continuation candidate keeps its original relative order.
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
  const continuation = original.flatMap((candidate, index) => {
    if (
      candidate.type !== "PODCAST" ||
      candidate.podcastListeningStatus !== "IN_PROGRESS" ||
      !candidate.spotifyEpisodeId
    ) {
      return [];
    }

    const state = listeningStateByEpisodeId.get(candidate.spotifyEpisodeId) ?? null;
    return [
      {
        candidate,
        index,
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

    return left.index - right.index;
  });

  const continuationCandidates = new Set(continuation.map((entry) => entry.candidate));
  const projected = [
    ...continuation.map((entry) => entry.candidate),
    ...original.filter((candidate) => !continuationCandidates.has(candidate)),
  ];
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
