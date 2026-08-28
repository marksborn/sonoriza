import type { Candidate } from "@/services/playlist-planner";

import type {
  PodcastShowPolicySnapshot,
  PodcastShowOrderValue,
} from "./podcast-show-policy-store";

export type PodcastEpisodeOrderValue =
  | "SOURCE_DEFAULT"
  | "OLDEST_FIRST"
  | "NEWEST_FIRST";

type RuntimePodcastShowPolicy = PodcastShowPolicySnapshot & {
  publishedEpisodeIds?: readonly string[];
};

export type PodcastShowPolicyResult = {
  candidates: Candidate[];
  stateFilteredCount: number;
  releaseExpiredCount: number;
  cursorFilteredCount: number;
  randomConsumedSkippedCount: number;
  sequenceBlocked: boolean;
  effectiveRandomRound: number;
  randomRoundReset: boolean;
};

/** Existing PODCAST-03 helper retained for compatibility and tests. */
export function sortShowCandidates(
  candidates: Candidate[],
  order: PodcastEpisodeOrderValue,
): Candidate[] {
  if (order === "SOURCE_DEFAULT") return [...candidates];
  return sortByPolicyOrder(candidates, order);
}

/**
 * PODCAST-05 pure policy engine. It never persists progress and never reads the
 * provider. Collection supplies canonical playback facts; GenerationItem audit
 * history supplies published traversal/shuffle memory.
 */
export function applyPodcastShowPolicy(
  candidates: Candidate[],
  policy: RuntimePodcastShowPolicy,
  now: Date = new Date(),
): PodcastShowPolicyResult {
  const allOrdered =
    policy.episodeOrder === "RANDOM"
      ? [...candidates]
      : sortByPolicyOrder(candidates, policy.episodeOrder);
  const positionByEpisodeId = new Map(
    allOrdered.flatMap((candidate, index) =>
      candidate.spotifyEpisodeId
        ? ([[candidate.spotifyEpisodeId, index]] as const)
        : [],
    ),
  );

  let stateFilteredCount = 0;
  let releaseExpiredCount = 0;
  const stateAndFreshnessEligible: Candidate[] = [];

  for (const candidate of allOrdered) {
    if (!passesListeningState(candidate, policy)) {
      stateFilteredCount += 1;
      continue;
    }
    if (!passesReleaseWindow(candidate, policy, now)) {
      releaseExpiredCount += 1;
      continue;
    }
    stateAndFreshnessEligible.push(candidate);
  }

  if (policy.episodeOrder === "RANDOM") {
    return applyRandomPolicy(
      stateAndFreshnessEligible,
      policy,
      stateFilteredCount,
      releaseExpiredCount,
    );
  }

  const sequenceStateful = policy.episodeEligibility !== "UNPLAYED_ONLY";
  const publishedEpisodeIds = policy.publishedEpisodeIds ?? [];
  const lastPublishedEpisodeId = sequenceStateful
    ? publishedEpisodeIds.at(-1) ?? null
    : null;

  let cursorFilteredCount = 0;
  let sequenceBlocked = false;
  let eligible = stateAndFreshnessEligible;

  if (lastPublishedEpisodeId) {
    const lastPublishedIndex = positionByEpisodeId.get(lastPublishedEpisodeId);
    if (lastPublishedIndex === undefined) {
      if (policy.strictSequence) {
        sequenceBlocked = true;
        eligible = [];
      }
    } else {
      eligible = stateAndFreshnessEligible.filter((candidate) => {
        const episodeId = candidate.spotifyEpisodeId;
        const position = episodeId ? positionByEpisodeId.get(episodeId) : undefined;
        const keep = position !== undefined && position > lastPublishedIndex;
        if (!keep) cursorFilteredCount += 1;
        return keep;
      });
    }
  } else if (policy.startEpisodeId) {
    const anchorIndex = positionByEpisodeId.get(policy.startEpisodeId);
    if (anchorIndex !== undefined) {
      eligible = stateAndFreshnessEligible.filter((candidate) => {
        const episodeId = candidate.spotifyEpisodeId;
        const position = episodeId ? positionByEpisodeId.get(episodeId) : undefined;
        const keep = position !== undefined && position >= anchorIndex;
        if (!keep) cursorFilteredCount += 1;
        return keep;
      });
    }
  }

  const decorated = eligible.map((candidate, index, list) => ({
    ...candidate,
    sourceIncludePlayed: policy.episodeEligibility !== "UNPLAYED_ONLY",
    podcastPolicySourceId: policy.sourcePlaylistId,
    podcastPolicyOrder: policy.episodeOrder,
    podcastRandomPolicy: policy.randomPolicy,
    podcastRandomRound: policy.randomRound,
    podcastRandomRoundReset: false,
    podcastSequenceStateful: sequenceStateful,
    podcastSequenceIndex: index,
    podcastNextSequenceEpisodeId: list[index + 1]?.spotifyEpisodeId ?? null,
    podcastStrictSequence: policy.strictSequence,
    podcastMaxEpisodesPerCycle: policy.maxEpisodesPerCycle,
  }));

  return {
    candidates: decorated,
    stateFilteredCount,
    releaseExpiredCount,
    cursorFilteredCount,
    randomConsumedSkippedCount: 0,
    sequenceBlocked,
    effectiveRandomRound: policy.randomRound,
    randomRoundReset: false,
  };
}

function applyRandomPolicy(
  candidates: Candidate[],
  policy: RuntimePodcastShowPolicy,
  stateFilteredCount: number,
  releaseExpiredCount: number,
): PodcastShowPolicyResult {
  const eligibleEpisodeIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.spotifyEpisodeId ? [candidate.spotifyEpisodeId] : [],
    ),
  );
  const published = policy.publishedEpisodeIds ?? [];
  let effectiveRandomRound = policy.randomRound;
  let randomRoundReset = false;
  let consumed = new Set(policy.randomConsumedEpisodeIds);

  if (policy.randomPolicy === "WITH_REPLACEMENT") {
    effectiveRandomRound += published.length;
    consumed = new Set();
  } else if (eligibleEpisodeIds.size > 0) {
    for (const episodeId of published) {
      if (!eligibleEpisodeIds.has(episodeId)) continue;
      consumed.add(episodeId);
      if (consumed.size >= eligibleEpisodeIds.size) {
        consumed = new Set();
        effectiveRandomRound += 1;
        randomRoundReset = true;
      }
    }
  }

  let randomConsumedSkippedCount = 0;
  const pool =
    policy.randomPolicy === "WITHOUT_REPLACEMENT"
      ? candidates.filter((candidate) => {
          const episodeId = candidate.spotifyEpisodeId;
          const alreadyConsumed = Boolean(episodeId && consumed.has(episodeId));
          if (alreadyConsumed) randomConsumedSkippedCount += 1;
          return !alreadyConsumed;
        })
      : candidates;

  const shuffled = deterministicShuffle(
    pool,
    `${policy.sourcePlaylistId}:${effectiveRandomRound}`,
  );
  const decorated = shuffled.map((candidate) => ({
    ...candidate,
    sourceIncludePlayed: policy.episodeEligibility !== "UNPLAYED_ONLY",
    podcastPolicySourceId: policy.sourcePlaylistId,
    podcastPolicyOrder: policy.episodeOrder,
    podcastRandomPolicy: policy.randomPolicy,
    podcastRandomRound: effectiveRandomRound,
    podcastRandomRoundReset: randomRoundReset,
    podcastSequenceStateful: false,
    podcastSequenceIndex: null,
    podcastNextSequenceEpisodeId: null,
    podcastStrictSequence: false,
    podcastMaxEpisodesPerCycle: policy.maxEpisodesPerCycle,
  }));

  return {
    candidates: decorated,
    stateFilteredCount,
    releaseExpiredCount,
    cursorFilteredCount: 0,
    randomConsumedSkippedCount,
    sequenceBlocked: false,
    effectiveRandomRound,
    randomRoundReset,
  };
}

function passesListeningState(
  candidate: Candidate,
  policy: RuntimePodcastShowPolicy,
): boolean {
  const status = candidate.podcastListeningStatus;
  if (!status) return policy.episodeEligibility !== "PLAYED_ONLY";
  if (policy.episodeEligibility === "ALL") return true;
  if (policy.episodeEligibility === "PLAYED_ONLY") return status === "COMPLETED";
  return status !== "COMPLETED";
}

function passesReleaseWindow(
  candidate: Candidate,
  policy: RuntimePodcastShowPolicy,
  now: Date,
): boolean {
  if (policy.maxReleaseAgeDays === null) return true;
  const releasedAt = latestPossibleReleaseInstant(
    candidate.releaseDate,
    candidate.releaseDatePrecision,
  );
  if (!releasedAt) return true;

  const expiresAt = new Date(
    releasedAt.getTime() + policy.maxReleaseAgeDays * 24 * 60 * 60 * 1000,
  );
  if (now.getTime() <= expiresAt.getTime()) return true;

  if (
    policy.expiryPolicy === "ALLOW_IN_PROGRESS_TO_FINISH" &&
    candidate.podcastListeningStatus === "IN_PROGRESS" &&
    candidate.podcastFirstProgressObservedAt &&
    candidate.podcastFirstProgressObservedAt.getTime() <= expiresAt.getTime()
  ) {
    return true;
  }

  return false;
}

function sortByPolicyOrder(
  candidates: Candidate[],
  order: "OLDEST_FIRST" | "NEWEST_FIRST",
): Candidate[] {
  const direction = order === "OLDEST_FIRST" ? 1 : -1;
  return [...candidates].sort((left, right) => {
    const leftKey = releaseKey(left.releaseDate, left.releaseDatePrecision);
    const rightKey = releaseKey(right.releaseDate, right.releaseDatePrecision);
    if (leftKey === null && rightKey !== null) return 1;
    if (leftKey !== null && rightKey === null) return -1;
    if (leftKey !== null && rightKey !== null && leftKey !== rightKey) {
      return (leftKey < rightKey ? -1 : 1) * direction;
    }
    return left.uri.localeCompare(right.uri);
  });
}

function releaseKey(date: string | undefined, precision: string | undefined): string | null {
  if (!date) return null;
  const parts = date.split("-");
  const year = Number(parts[0]);
  if (!Number.isInteger(year)) return null;
  const month = precision === "year" ? 0 : Number(parts[1] ?? 0);
  const day = precision === "day" ? Number(parts[2] ?? 0) : 0;
  if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Spotify can return year/month precision. Use the latest possible instant in
 * that known period so an imprecise release date is never expired too early.
 */
function latestPossibleReleaseInstant(
  date: string | undefined,
  precision: string | undefined,
): Date | null {
  if (!date) return null;
  const parts = date.split("-").map(Number);
  const year = parts[0];
  if (!Number.isInteger(year) || year < 1) return null;

  if (precision === "year") {
    return new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
  }

  const month = parts[1];
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (precision === "month") {
    return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  }

  const day = parts[2];
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
}

function deterministicShuffle(candidates: Candidate[], seed: string): Candidate[] {
  return [...candidates]
    .map((candidate) => ({
      candidate,
      key: stableHash(`${seed}:${candidate.spotifyEpisodeId ?? candidate.uri}`),
    }))
    .sort(
      (left, right) =>
        left.key - right.key || left.candidate.uri.localeCompare(right.candidate.uri),
    )
    .map((entry) => entry.candidate);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
