import type {
  Candidate,
  ContentType,
  PlannedItem,
  PlanResult,
  PlaylistRules,
} from "./types";

export interface PlannerPools {
  music: Candidate[];
  podcasts: Candidate[];
}

export interface PlanPlaylistInput {
  rules: PlaylistRules;
  pools: PlannerPools;
  reserved?: Iterable<string>;
  /** SCHEDULE-01: valid items already present in this target, in remote order. */
  preserved?: Candidate[];
  /**
   * CALENDAR-02: items selected by previous blocks. They seed cross-block
   * program/diversity constraints without consuming this block's duration.
   */
  constraintSeed?: Candidate[];
  /** CALENDAR-02: when true, no selected item may cross this duration budget. */
  strictDurationBoundary?: boolean;
  /** CALENDAR-02: keep SEQUENCE continuous across concatenated blocks. */
  sequenceStartIndex?: number;
}

const MIX_QUALITY_TOLERANCE_POINTS = 10;

type MusicDiversityState = {
  maxTracksPerArtist: number | null;
  maxTracksPerAlbum: number | null;
  artistCounts: Map<string, number>;
  albumCounts: Map<string, number>;
  distinctArtistIds: Set<string>;
  distinctAlbumIds: Set<string>;
  artistLimitRejectedUris: Set<string>;
  albumLimitRejectedUris: Set<string>;
  missingArtistIdentityRejectedUris: Set<string>;
  missingAlbumIdentityRejectedUris: Set<string>;
};

export function planPlaylist({
  rules,
  pools,
  reserved,
  preserved,
  constraintSeed,
  strictDurationBoundary = false,
  sequenceStartIndex = 0,
}: PlanPlaylistInput): PlanResult {
  const target = Math.max(0, rules.targetDurationMs);
  const podcastPercent = clamp(rules.podcastPercent, 0, 100);
  const maxPodcastDurationMs =
    rules.maxPodcastDurationMs == null
      ? null
      : Math.max(0, rules.maxPodcastDurationMs);

  const eligiblePodcasts: Candidate[] = [];
  let podcastIdentityMissingCount = 0;
  let podcastDurationExceededCount = 0;

  for (const candidate of pools.podcasts) {
    const programId = candidate.programId?.trim();
    if (!programId) {
      podcastIdentityMissingCount += 1;
      continue;
    }
    if (
      maxPodcastDurationMs !== null &&
      Math.max(0, candidate.durationMs) > maxPodcastDurationMs
    ) {
      podcastDurationExceededCount += 1;
      continue;
    }
    eligiblePodcasts.push(
      programId === candidate.programId
        ? candidate
        : { ...candidate, programId },
    );
  }

  const poolByType: Record<ContentType, Candidate[]> = {
    MUSIC: pools.music,
    PODCAST: eligiblePodcasts,
  };
  const used = new Set<string>(reserved ?? []);
  const newlyUsed = new Set<string>();
  const programCounts = new Map<string, number>();
  const musicDiversity: MusicDiversityState = {
    maxTracksPerArtist: normalizeDiversityLimit(rules.maxTracksPerArtist),
    maxTracksPerAlbum: normalizeDiversityLimit(rules.maxTracksPerAlbum),
    artistCounts: new Map(),
    albumCounts: new Map(),
    distinctArtistIds: new Set(),
    distinctAlbumIds: new Set(),
    artistLimitRejectedUris: new Set(),
    albumLimitRejectedUris: new Set(),
    missingArtistIdentityRejectedUris: new Set(),
    missingAlbumIdentityRejectedUris: new Set(),
  };
  const items: PlannedItem[] = [];
  let musicDurationMs = 0;
  let podcastDurationMs = 0;

  for (const candidate of constraintSeed ?? []) {
    seedConstraintState(candidate, programCounts, musicDiversity);
  }

  const totalDuration = () => musicDurationMs + podcastDurationMs;
  const place = (candidate: Candidate) => {
    items.push({ ...candidate, position: items.length });
    used.add(candidate.uri);
    newlyUsed.add(candidate.uri);

    if (candidate.type === "PODCAST") {
      podcastDurationMs += Math.max(0, candidate.durationMs);
      const programId = candidate.programId!;
      programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
      return;
    }

    musicDurationMs += Math.max(0, candidate.durationMs);
    const artistId = normalizedIdentity(candidate.primaryArtistId);
    const albumId = normalizedIdentity(candidate.albumId);
    if (artistId) {
      musicDiversity.artistCounts.set(
        artistId,
        (musicDiversity.artistCounts.get(artistId) ?? 0) + 1,
      );
      musicDiversity.distinctArtistIds.add(artistId);
    }
    if (albumId) {
      musicDiversity.albumCounts.set(
        albumId,
        (musicDiversity.albumCounts.get(albumId) ?? 0) + 1,
      );
      musicDiversity.distinctAlbumIds.add(albumId);
    }
  };

  for (const candidate of preserved ?? []) {
    if (used.has(candidate.uri) || candidate.durationMs <= 0) continue;
    if (
      strictDurationBoundary &&
      candidate.durationMs > Math.max(0, target - totalDuration())
    ) {
      continue;
    }
    if (
      rules.compositionMode === "SEQUENCE" &&
      rules.sequencePattern.length > 0 &&
      candidate.type !==
        rules.sequencePattern[
          (sequenceStartIndex + items.length) % rules.sequencePattern.length
        ]
    ) {
      continue;
    }
    place(candidate);
  }

  let sequenceSlotsRequested = 0;
  let sequenceSlotsFilled = 0;
  let sequenceUnfilledSlots = 0;
  let completedCycles = 0;
  let stoppedAtPatternIndex: number | null = null;
  let sequenceQualityPassed: boolean | null = null;
  let sequenceStopReason: PlanResult["stats"]["sequenceStopReason"] = null;

  if (rules.compositionMode === "SEQUENCE") {
    const pattern = rules.sequencePattern;
    if (pattern.length === 0) {
      sequenceQualityPassed = false;
      sequenceStopReason = "INVALID_PATTERN";
    } else {
      sequenceQualityPassed = true;
      let patternIndex = (sequenceStartIndex + items.length) % pattern.length;
      sequenceSlotsRequested = items.length;
      sequenceSlotsFilled = items.length;
      completedCycles = Math.floor((sequenceStartIndex + items.length) / pattern.length) -
        Math.floor(sequenceStartIndex / pattern.length);

      while (totalDuration() < target) {
        const remainingMs = target - totalDuration();
        const slotType = pattern[patternIndex]!;
        sequenceSlotsRequested += 1;

        const candidate = pickCandidate(
          poolByType[slotType],
          used,
          programCounts,
          rules.maxEpisodesPerProgram,
          remainingMs,
          musicDiversity,
        );

        if (!candidate) {
          const sameTypeCandidateExists = Boolean(
            pickCandidate(
              poolByType[slotType],
              used,
              programCounts,
              rules.maxEpisodesPerProgram,
              Number.POSITIVE_INFINITY,
              musicDiversity,
            ),
          );
          sequenceUnfilledSlots = 1;
          stoppedAtPatternIndex = patternIndex;
          sequenceStopReason = sameTypeCandidateExists
            ? "NO_FITTING_CANDIDATE"
            : "NO_CANDIDATE_FOR_SLOT";
          break;
        }

        place(candidate);
        sequenceSlotsFilled += 1;
        patternIndex = (patternIndex + 1) % pattern.length;
        if (patternIndex === 0) completedCycles += 1;
      }

      if (totalDuration() >= target) sequenceStopReason = "TARGET_REACHED";
    }
  } else {
    while (totalDuration() < target) {
      const remainingMs = target - totalDuration();
      const maxCandidateDurationMs = strictDurationBoundary
        ? remainingMs
        : Number.POSITIVE_INFINITY;
      const music = pickCandidate(
        poolByType.MUSIC,
        used,
        programCounts,
        rules.maxEpisodesPerProgram,
        maxCandidateDurationMs,
        musicDiversity,
      );
      const podcast = pickCandidate(
        poolByType.PODCAST,
        used,
        programCounts,
        rules.maxEpisodesPerProgram,
        maxCandidateDurationMs,
        musicDiversity,
      );
      if (!music && !podcast) break;

      place(
        chooseProportionCandidate({
          music,
          podcast,
          podcastPercent,
          musicDurationMs,
          podcastDurationMs,
        }),
      );
    }
  }

  const totalDurationMs = totalDuration();
  const actualPodcastPercent =
    totalDurationMs > 0
      ? round1((podcastDurationMs / totalDurationMs) * 100)
      : target === 0
        ? podcastPercent
        : 0;
  const poolExhausted = totalDurationMs < target;
  const podcastBudget = (target * podcastPercent) / 100;
  const musicBudget = target - podcastBudget;

  const proportionMode = rules.compositionMode === "PROPORTION";
  const podcastShortfallMs = proportionMode
    ? Math.max(0, podcastBudget - podcastDurationMs)
    : 0;
  const musicShortfallMs = proportionMode
    ? Math.max(0, musicBudget - musicDurationMs)
    : 0;
  const mixDeviationPoints = proportionMode
    ? round1(Math.abs(actualPodcastPercent - podcastPercent))
    : 0;
  const proportionQualityPassed =
    target === 0 ||
    (mixDeviationPoints <= MIX_QUALITY_TOLERANCE_POINTS &&
      (strictDurationBoundary || !poolExhausted));
  const compositionQualityPassed = proportionMode
    ? proportionQualityPassed
    : sequenceQualityPassed === true;

  return {
    items,
    usedUris: newlyUsed,
    stats: {
      compositionMode: rules.compositionMode,
      totalDurationMs,
      musicDurationMs,
      podcastDurationMs,
      musicCount: items.filter((item) => item.type === "MUSIC").length,
      podcastCount: items.filter((item) => item.type === "PODCAST").length,
      actualPodcastPercent,
      requestedPodcastPercent: podcastPercent,
      podcastShortfallMs,
      musicShortfallMs,
      mixDeviationPoints,
      mixQualityPassed: compositionQualityPassed,
      compositionQualityPassed,
      unfilledSlots: sequenceUnfilledSlots,
      poolExhausted,
      podcastIdentityMissingCount,
      podcastDurationExceededCount,
      distinctArtistCount: musicDiversity.distinctArtistIds.size,
      distinctAlbumCount: musicDiversity.distinctAlbumIds.size,
      artistLimitRejectedCount: musicDiversity.artistLimitRejectedUris.size,
      albumLimitRejectedCount: musicDiversity.albumLimitRejectedUris.size,
      missingArtistIdentityRejectedCount:
        musicDiversity.missingArtistIdentityRejectedUris.size,
      missingAlbumIdentityRejectedCount:
        musicDiversity.missingAlbumIdentityRejectedUris.size,
      sequenceSlotsRequested,
      sequenceSlotsFilled,
      sequenceUnfilledSlots,
      completedCycles,
      finalPartialCycleSlots:
        rules.compositionMode === "SEQUENCE" && rules.sequencePattern.length > 0
          ? sequenceSlotsFilled % rules.sequencePattern.length
          : 0,
      stoppedAtPatternIndex,
      sequenceQualityPassed,
      sequenceStopReason,
    },
  };
}

function seedConstraintState(
  candidate: Candidate,
  programCounts: Map<string, number>,
  musicDiversity: MusicDiversityState,
) {
  if (candidate.type === "PODCAST") {
    const programId = normalizedIdentity(candidate.programId);
    if (programId) {
      programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
    }
    return;
  }

  const artistId = normalizedIdentity(candidate.primaryArtistId);
  const albumId = normalizedIdentity(candidate.albumId);
  if (artistId) {
    musicDiversity.artistCounts.set(
      artistId,
      (musicDiversity.artistCounts.get(artistId) ?? 0) + 1,
    );
    musicDiversity.distinctArtistIds.add(artistId);
  }
  if (albumId) {
    musicDiversity.albumCounts.set(
      albumId,
      (musicDiversity.albumCounts.get(albumId) ?? 0) + 1,
    );
    musicDiversity.distinctAlbumIds.add(albumId);
  }
}

function chooseProportionCandidate(input: {
  music: Candidate | null;
  podcast: Candidate | null;
  podcastPercent: number;
  musicDurationMs: number;
  podcastDurationMs: number;
}): Candidate {
  if (!input.music) return input.podcast!;
  if (!input.podcast) return input.music;
  if (input.podcastPercent <= 0) return input.music;
  if (input.podcastPercent >= 100) return input.podcast;

  const score = (candidate: Candidate) => {
    const podcastDuration =
      input.podcastDurationMs +
      (candidate.type === "PODCAST" ? Math.max(0, candidate.durationMs) : 0);
    const musicDuration =
      input.musicDurationMs +
      (candidate.type === "MUSIC" ? Math.max(0, candidate.durationMs) : 0);
    const total = podcastDuration + musicDuration;
    const actual = total > 0 ? (podcastDuration / total) * 100 : 0;
    return Math.abs(actual - input.podcastPercent);
  };

  const musicScore = score(input.music);
  const podcastScore = score(input.podcast);
  if (podcastScore < musicScore) return input.podcast;
  if (musicScore < podcastScore) return input.music;

  const targetRatio = input.podcastPercent / 100;
  const currentTotal = input.musicDurationMs + input.podcastDurationMs;
  const currentPodcastTarget = currentTotal * targetRatio;
  return input.podcastDurationMs < currentPodcastTarget
    ? input.podcast
    : input.music;
}

function pickCandidate(
  pool: Candidate[],
  used: Set<string>,
  programCounts: Map<string, number>,
  maxEpisodesPerProgram: number,
  maxDurationMs: number,
  musicDiversity: MusicDiversityState,
): Candidate | null {
  for (const candidate of pool) {
    if (used.has(candidate.uri)) continue;
    if (candidate.durationMs <= 0 || candidate.durationMs > maxDurationMs) continue;

    if (candidate.type === "PODCAST") {
      if (!candidate.programId) continue;
      const count = programCounts.get(candidate.programId) ?? 0;
      if (count >= maxEpisodesPerProgram) continue;
      return candidate;
    }

    if (!musicCandidatePassesDiversity(candidate, musicDiversity)) continue;
    return candidate;
  }
  return null;
}

function musicCandidatePassesDiversity(
  candidate: Candidate,
  state: MusicDiversityState,
): boolean {
  let valid = true;

  if (state.maxTracksPerArtist !== null) {
    const artistId = normalizedIdentity(candidate.primaryArtistId);
    if (!artistId) {
      state.missingArtistIdentityRejectedUris.add(candidate.uri);
      valid = false;
    } else if (
      (state.artistCounts.get(artistId) ?? 0) >= state.maxTracksPerArtist
    ) {
      state.artistLimitRejectedUris.add(candidate.uri);
      valid = false;
    }
  }

  if (state.maxTracksPerAlbum !== null) {
    const albumId = normalizedIdentity(candidate.albumId);
    if (!albumId) {
      state.missingAlbumIdentityRejectedUris.add(candidate.uri);
      valid = false;
    } else if ((state.albumCounts.get(albumId) ?? 0) >= state.maxTracksPerAlbum) {
      state.albumLimitRejectedUris.add(candidate.uri);
      valid = false;
    }
  }

  return valid;
}

function normalizeDiversityLimit(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
