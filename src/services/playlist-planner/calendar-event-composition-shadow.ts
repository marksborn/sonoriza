import type { CalendarEventCompositionPolicySnapshot } from "../calendar-event-composition-policy";
import { planPlaylist, type PlannerPools } from "./planner";
import { selectFittingPodcastsInCanonicalOrder } from "./podcast-fit";
import type {
  Candidate,
  DurationPlanningBlock,
  PlannedItem,
  PlaylistRules,
} from "./types";

export type Calendar03ShadowStatus =
  | "READY_SHADOW"
  | "ABSTAIN_INHERIT_DESTINATION"
  | "ABSTAIN_NO_PER_EVENT_BLOCKS";

export type Calendar03EventDiagnosticCode =
  | "EVENT_PODCAST_SELECTED"
  | "EVENT_PODCAST_NO_FITTING_CANDIDATE"
  | "EVENT_PODCAST_DISTRIBUTION_SKIPPED"
  | "EVENT_PODCAST_PRESERVED_PREFIX"
  | "EVENT_PRESERVED_SUFFIX_TRUNCATED";

export type Calendar03ProjectedBlock = Readonly<{
  index: number;
  key: string;
  targetDurationMs: number;
  podcastUsableDurationMs: number;
  podcastAttempted: boolean;
  selectedPodcastUris: string[];
  selectedMusicUris: string[];
  podcastDurationMs: number;
  musicDurationMs: number;
  filledDurationMs: number;
  deficitMs: number;
  musicCompositionQualityPassed: boolean;
  musicPoolExhausted: boolean;
  diagnosticCodes: Calendar03EventDiagnosticCode[];
}>;

export type Calendar03EventCompositionShadow = Readonly<{
  status: Calendar03ShadowStatus;
  policyVersion: "calendar03-gate2-shadow-v1";
  plannerInfluence: false;
  spotifyWrites: false;
  databaseWrites: false;
  items: PlannedItem[];
  usedUris: Set<string>;
  blocks: Calendar03ProjectedBlock[];
}>;

export type ProjectCalendar03EventCompositionInput = Readonly<{
  policy: CalendarEventCompositionPolicySnapshot;
  blocks: DurationPlanningBlock[];
  rules: PlaylistRules;
  pools: PlannerPools;
  reserved?: Iterable<string>;
  /**
   * KEEP_FILLED: canonical valid remote prefix. Preserved items remain before
   * every fresh item and are reconciled against current event windows before
   * CALENDAR-03 is allowed to fill the remaining budget.
   */
  preserved?: Candidate[];
}>;

/**
 * CALENDAR-03 Gate 2 — read-only planner projection.
 *
 * Gate 3 reuses this same pure projection behind a guarded runtime seam. It
 * receives already-resolved CALENDAR-02 PER_EVENT blocks and projects
 * PODCAST_THEN_MUSIC without Spotify/database access. The incoming podcast
 * order is authoritative: duration is only a fit filter and never a best-fit
 * ranking signal.
 *
 * Candidate.durationMs is the effective listening duration used by the current
 * planner. For IN_PROGRESS episodes ingestion already supplies the remaining
 * duration, so CALENDAR-03 compares that remaining duration against the current
 * event window. No item may cross the block boundary.
 *
 * KEEP_FILLED preserved content is a stable physical prefix. CALENDAR-03 keeps
 * the largest contiguous prefix that can still be reconciled with the current
 * event windows. A valid preserved suffix may cross to the next event only when
 * the current event is already exactly full, so no fresh item needs to jump in
 * front of it. At the first preserved item that cannot continue that contiguous
 * prefix, that item and the whole remaining suffix are dropped for this run and
 * reserved from fresh reselection. The writer can then remove those dropped
 * preserved URIs while CALENDAR-03 fills the newly released budget normally.
 */
export function projectCalendar03EventComposition(
  input: ProjectCalendar03EventCompositionInput,
): Calendar03EventCompositionShadow {
  if (input.policy.eventCompositionPolicy !== "PODCAST_THEN_MUSIC") {
    return emptyProjection("ABSTAIN_INHERIT_DESTINATION");
  }

  if (input.blocks.length === 0) {
    return emptyProjection("ABSTAIN_NO_PER_EVENT_BLOCKS");
  }

  const localReserved = new Set(input.reserved ?? []);
  const usedUris = new Set<string>();
  const selected: PlannedItem[] = [];
  const programCounts = new Map<string, number>();
  const projectedBlocks: Calendar03ProjectedBlock[] = [];
  const preservedQueue = [...(input.preserved ?? [])];
  const safetyMarginMs = Math.max(
    0,
    input.policy.podcastEventSafetyMarginSeconds * 1000,
  );

  for (let blockIndex = 0; blockIndex < input.blocks.length; blockIndex += 1) {
    const block = input.blocks[blockIndex]!;
    const targetDurationMs = Math.max(0, block.targetDurationMs);
    const podcastUsableDurationMs = Math.max(0, targetDurationMs - safetyMarginMs);
    const podcastAttempted = eventReceivesPodcast(input.policy, blockIndex);
    const preservedForBlock: Candidate[] = [];
    let preservedDurationMs = 0;
    let preservedPodcastDurationMs = 0;
    let preservedMusicDurationMs = 0;
    let preservedPodcastCount = 0;
    let preservedMusicStarted = false;
    let truncatedPreservedSuffixCount = 0;

    const truncatePreservedSuffix = () => {
      const truncated = preservedQueue.splice(0);
      truncatedPreservedSuffixCount += truncated.length;
      for (const item of truncated) {
        // A URI that lost preserved status must not be selected again as fresh
        // content in the same run. Otherwise the maintenance writer could
        // mistake it for an unchanged preserved item and fail to move/remove it.
        localReserved.add(item.uri);
      }
    };

    while (preservedQueue.length > 0) {
      const candidate = preservedQueue[0]!;
      const durationMs = Math.max(0, candidate.durationMs);

      if (durationMs <= 0) {
        truncatePreservedSuffix();
        break;
      }

      if (candidate.type === "PODCAST") {
        const programId = candidate.programId?.trim();
        const programCap = effectiveProgramCap(candidate, input.rules);
        if (programId && (programCounts.get(programId) ?? 0) >= programCap) {
          truncatePreservedSuffix();
          break;
        }
      }

      if (preservedDurationMs >= targetDurationMs) {
        if (blockIndex < input.blocks.length - 1) {
          // Exact boundary: the next preserved item can remain the first item
          // of the next event without any fresh content overtaking it.
          break;
        }
        // The final event is already full; anything after it is outside the
        // current target and therefore no longer belongs to the preserved prefix.
        truncatePreservedSuffix();
        break;
      }

      if (candidate.type === "PODCAST") {
        const programId = candidate.programId?.trim();
        const fitsCurrent =
          podcastAttempted &&
          !preservedMusicStarted &&
          preservedPodcastCount < input.policy.maxPodcastsPerEvent &&
          preservedDurationMs + durationMs <= targetDurationMs &&
          preservedPodcastDurationMs + durationMs <= podcastUsableDurationMs;

        if (!fitsCurrent) {
          truncatePreservedSuffix();
          break;
        }

        preservedForBlock.push(candidate);
        preservedQueue.shift();
        preservedDurationMs += durationMs;
        preservedPodcastDurationMs += durationMs;
        preservedPodcastCount += 1;
        if (programId) {
          programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
        }
        continue;
      }

      if (preservedDurationMs + durationMs > targetDurationMs) {
        truncatePreservedSuffix();
        break;
      }

      preservedForBlock.push(candidate);
      preservedQueue.shift();
      preservedDurationMs += durationMs;
      preservedMusicDurationMs += durationMs;
      preservedMusicStarted = true;
    }

    const blockStartPosition = selected.length;
    for (const item of preservedForBlock) {
      selected.push({
        ...item,
        position: selected.length,
        planningBlockIndex: blockIndex,
      });
      localReserved.add(item.uri);
      usedUris.add(item.uri);
    }

    // A preserved suffix may remain only across an exact event boundary. In
    // that case the current block has no remaining budget, so no fresh content
    // needs to be inserted in front of that suffix.
    const preservingFuturePrefix = preservedQueue.length > 0;
    const canAppendFreshPodcast =
      !preservingFuturePrefix &&
      podcastAttempted &&
      !preservedMusicStarted &&
      preservedPodcastCount < input.policy.maxPodcastsPerEvent &&
      podcastUsableDurationMs > preservedPodcastDurationMs;

    const podcastFit = canAppendFreshPodcast
      ? selectFittingPodcastsInCanonicalOrder({
          candidates: input.pools.podcasts,
          reservedUris: localReserved,
          budgetMs: Math.max(
            0,
            podcastUsableDurationMs - preservedPodcastDurationMs,
          ),
          maxCount: Math.max(
            0,
            input.policy.maxPodcastsPerEvent - preservedPodcastCount,
          ),
          programCounts,
          rules: input.rules,
        })
      : { selected: [] as readonly Candidate[], selectedDurationMs: 0 };

    const selectedPodcasts = [...podcastFit.selected];
    for (const podcast of selectedPodcasts) {
      const programId = podcast.programId?.trim();
      if (programId) {
        programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
      }
      localReserved.add(podcast.uri);
      usedUris.add(podcast.uri);
      selected.push({
        ...podcast,
        position: selected.length,
        planningBlockIndex: blockIndex,
      });
    }

    const freshPodcastDurationMs = podcastFit.selectedDurationMs;
    const remainingMusicDurationMs = Math.max(
      0,
      targetDurationMs - preservedDurationMs - freshPodcastDurationMs,
    );
    const musicResult = preservingFuturePrefix
      ? null
      : planPlaylist({
          rules: {
            ...input.rules,
            targetDurationMs: remainingMusicDurationMs,
            compositionMode: "PROPORTION",
            podcastPercent: 0,
          },
          pools: {
            music: input.pools.music,
            podcasts: [],
          },
          reserved: localReserved,
          constraintSeed: selected,
          strictDurationBoundary: true,
        });

    const selectedMusicUris = preservedForBlock
      .filter((item) => item.type === "MUSIC")
      .map((item) => item.uri);
    if (musicResult) {
      for (const item of musicResult.items) {
        const planned: PlannedItem = {
          ...item,
          position: selected.length,
          planningBlockIndex: blockIndex,
        };
        selected.push(planned);
        selectedMusicUris.push(item.uri);
      }
      for (const uri of musicResult.usedUris) {
        localReserved.add(uri);
        usedUris.add(uri);
      }
    }

    const podcastDurationMs = preservedPodcastDurationMs + freshPodcastDurationMs;
    const musicDurationMs =
      preservedMusicDurationMs + (musicResult?.stats.musicDurationMs ?? 0);
    const filledDurationMs = podcastDurationMs + musicDurationMs;
    const deficitMs = Math.max(0, targetDurationMs - filledDurationMs);
    const selectedPodcastUris = [
      ...preservedForBlock
        .filter((item) => item.type === "PODCAST")
        .map((item) => item.uri),
      ...selectedPodcasts.map((candidate) => candidate.uri),
    ];
    const diagnosticCodes: Calendar03EventDiagnosticCode[] = [];

    if (!podcastAttempted) {
      diagnosticCodes.push("EVENT_PODCAST_DISTRIBUTION_SKIPPED");
    } else if (selectedPodcastUris.length > 0) {
      diagnosticCodes.push("EVENT_PODCAST_SELECTED");
    } else if (preservedMusicStarted) {
      diagnosticCodes.push("EVENT_PODCAST_PRESERVED_PREFIX");
    } else {
      diagnosticCodes.push("EVENT_PODCAST_NO_FITTING_CANDIDATE");
    }
    if (truncatedPreservedSuffixCount > 0) {
      diagnosticCodes.push("EVENT_PRESERVED_SUFFIX_TRUNCATED");
    }

    projectedBlocks.push({
      index: blockIndex,
      key: block.key,
      targetDurationMs,
      podcastUsableDurationMs,
      podcastAttempted,
      selectedPodcastUris,
      selectedMusicUris,
      podcastDurationMs,
      musicDurationMs,
      filledDurationMs,
      deficitMs,
      musicCompositionQualityPassed:
        remainingMusicDurationMs === 0 ||
        (!preservingFuturePrefix && Boolean(musicResult?.stats.compositionQualityPassed)),
      musicPoolExhausted:
        remainingMusicDurationMs === 0
          ? false
          : musicResult?.stats.poolExhausted ?? preservingFuturePrefix,
      diagnosticCodes,
    });

    const blockDurationMs = selected
      .slice(blockStartPosition)
      .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
    if (blockDurationMs > targetDurationMs) {
      throw new Error("CALENDAR-03 projection crossed an event duration boundary.");
    }
  }

  return {
    status: "READY_SHADOW",
    policyVersion: "calendar03-gate2-shadow-v1",
    plannerInfluence: false,
    spotifyWrites: false,
    databaseWrites: false,
    items: selected,
    usedUris,
    blocks: projectedBlocks,
  };
}

function eventReceivesPodcast(
  policy: CalendarEventCompositionPolicySnapshot,
  blockIndex: number,
): boolean {
  if (policy.podcastEventDistribution === "EVERY_EVENT") return true;
  return blockIndex % policy.podcastEveryNEvents === policy.podcastEventOffset;
}

function effectiveProgramCap(candidate: Candidate, rules: PlaylistRules): number {
  const targetCap = Math.max(1, Math.trunc(rules.maxEpisodesPerProgram || 1));
  const showCap = candidate.podcastMaxEpisodesPerCycle;
  if (!Number.isInteger(showCap) || Number(showCap) < 1) return targetCap;
  return Math.min(targetCap, Number(showCap));
}

function emptyProjection(status: Exclude<Calendar03ShadowStatus, "READY_SHADOW">) {
  return {
    status,
    policyVersion: "calendar03-gate2-shadow-v1" as const,
    plannerInfluence: false as const,
    spotifyWrites: false as const,
    databaseWrites: false as const,
    items: [],
    usedUris: new Set<string>(),
    blocks: [],
  };
}
