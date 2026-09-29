import type { Candidate } from "./types";

export type PodcastContinuationProjection = Readonly<{
  candidates: Candidate[];
  continuationCandidateCount: number;
  promotedEpisodeIds: string[];
  selectedEpisodeId: string | null;
  movedCount: number;
}>;

/**
 * PODCAST-09 Gate 3.1 pure projection.
 *
 * Continuation is destination-local: an episode may be promoted only when it
 * is already present in the current destination playlist, is still an eligible
 * PODCAST candidate and is canonically IN_PROGRESS. Presence in the destination
 * alone never creates eligibility and IN_PROGRESS outside the destination never
 * competes for continuation priority.
 *
 * If more than one current-destination episode is still IN_PROGRESS, V1 picks
 * exactly one: the first such episode in the previous destination order. Only
 * that episode is moved to the first PODCAST position; every other podcast keeps
 * its existing relative order. Non-PODCAST positions are preserved exactly, so
 * MUSIC/PODCAST sequence composition cannot be changed by this projection.
 */
export function projectPodcastContinuationPriority(input: {
  candidates: readonly Candidate[];
  currentDestinationEpisodeIds?: readonly string[];
}): PodcastContinuationProjection {
  const original = [...input.candidates];
  const destinationEpisodeIds = input.currentDestinationEpisodeIds;

  if (!destinationEpisodeIds) return noChange(original);

  const podcastCandidates = original.filter((candidate) => candidate.type === "PODCAST");
  const eligibleByEpisodeId = new Map<string, Candidate>();

  for (const candidate of podcastCandidates) {
    if (
      candidate.podcastListeningStatus !== "IN_PROGRESS" ||
      !candidate.spotifyEpisodeId ||
      eligibleByEpisodeId.has(candidate.spotifyEpisodeId)
    ) {
      continue;
    }
    eligibleByEpisodeId.set(candidate.spotifyEpisodeId, candidate);
  }

  const destinationContinuations: Array<{ episodeId: string; candidate: Candidate }> = [];
  const seenDestinationIds = new Set<string>();
  for (const rawEpisodeId of destinationEpisodeIds) {
    const episodeId = rawEpisodeId.trim();
    if (!episodeId || seenDestinationIds.has(episodeId)) continue;
    seenDestinationIds.add(episodeId);
    const candidate = eligibleByEpisodeId.get(episodeId);
    if (!candidate) continue;
    destinationContinuations.push({ episodeId, candidate });
  }

  const selected = destinationContinuations[0] ?? null;
  if (!selected) return noChange(original);

  const projectedPodcasts = [
    selected.candidate,
    ...podcastCandidates.filter((candidate) => candidate !== selected.candidate),
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

  return {
    candidates: projected,
    continuationCandidateCount: destinationContinuations.length,
    promotedEpisodeIds: [selected.episodeId],
    selectedEpisodeId: selected.episodeId,
    movedCount,
  };
}

function noChange(candidates: Candidate[]): PodcastContinuationProjection {
  return {
    candidates,
    continuationCandidateCount: 0,
    promotedEpisodeIds: [],
    selectedEpisodeId: null,
    movedCount: 0,
  };
}
