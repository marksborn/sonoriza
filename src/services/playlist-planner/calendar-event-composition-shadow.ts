import type { CalendarEventCompositionPolicySnapshot } from "../calendar-event-composition-policy";
import { planPlaylist, type PlannerPools } from "./planner";
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
  | "EVENT_PODCAST_DISTRIBUTION_SKIPPED";

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
}>;

/**
 * CALENDAR-03 Gate 2 — read-only planner projection.
 *
 * This function deliberately is NOT wired into planRun yet. It receives the
 * already-resolved CALENDAR-02 PER_EVENT blocks and projects PODCAST_THEN_MUSIC
 * without Spotify/database access. The incoming podcast order is authoritative:
 * duration is only a fit filter and never a best-fit ranking signal.
 *
 * Candidate.durationMs is the effective listening duration used by the current
 * planner. For IN_PROGRESS episodes ingestion already supplies the remaining
 * duration, so Gate 2 compares that remaining duration against the current
 * event window. No item may cross the block boundary.
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
  const safetyMarginMs = Math.max(
    0,
    input.policy.podcastEventSafetyMarginSeconds * 1000,
  );

  for (let blockIndex = 0; blockIndex < input.blocks.length; blockIndex += 1) {
    const block = input.blocks[blockIndex]!;
    const targetDurationMs = Math.max(0, block.targetDurationMs);
    const podcastUsableDurationMs = Math.max(0, targetDurationMs - safetyMarginMs);
    const podcastAttempted = eventReceivesPodcast(input.policy, blockIndex);
    const selectedPodcasts: Candidate[] = [];
    const strictProgramBlocked = new Set<string>();
    let podcastDurationMs = 0;

    if (podcastAttempted && podcastUsableDurationMs > 0) {
      for (const candidate of input.pools.podcasts) {
        if (selectedPodcasts.length >= input.policy.maxPodcastsPerEvent) break;
        if (candidate.type !== "PODCAST") continue;
        if (localReserved.has(candidate.uri)) continue;

        const programId = candidate.programId?.trim();
        if (!programId) continue;
        if (strictProgramBlocked.has(programId)) continue;

        const effectiveDurationMs = Math.max(0, candidate.durationMs);
        if (effectiveDurationMs <= 0) continue;

        const cap = effectiveProgramCap(candidate, input.rules);
        if ((programCounts.get(programId) ?? 0) >= cap) continue;

        const remainingPodcastWindowMs = Math.max(
          0,
          podcastUsableDurationMs - podcastDurationMs,
        );
        const maxPodcastDurationMs = input.rules.maxPodcastDurationMs ?? null;
        const fitsDestinationCap =
          maxPodcastDurationMs === null ||
          effectiveDurationMs <= Math.max(0, maxPodcastDurationMs);
        const fitsCurrentWindow = effectiveDurationMs <= remainingPodcastWindowMs;

        if (!fitsDestinationCap || !fitsCurrentWindow) {
          if (candidate.podcastStrictSequence) strictProgramBlocked.add(programId);
          continue;
        }

        selectedPodcasts.push(
          programId === candidate.programId
            ? candidate
            : { ...candidate, programId },
        );
        podcastDurationMs += effectiveDurationMs;
        programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
        localReserved.add(candidate.uri);
        usedUris.add(candidate.uri);
      }
    }

    const blockStartPosition = selected.length;
    for (const podcast of selectedPodcasts) {
      selected.push({
        ...podcast,
        position: selected.length,
        planningBlockIndex: blockIndex,
      });
    }

    const musicTargetDurationMs = Math.max(0, targetDurationMs - podcastDurationMs);
    const musicResult = planPlaylist({
      rules: {
        ...input.rules,
        targetDurationMs: musicTargetDurationMs,
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

    const selectedMusicUris: string[] = [];
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

    const musicDurationMs = musicResult.stats.musicDurationMs;
    const filledDurationMs = podcastDurationMs + musicDurationMs;
    const diagnosticCodes: Calendar03EventDiagnosticCode[] = [];

    if (!podcastAttempted) {
      diagnosticCodes.push("EVENT_PODCAST_DISTRIBUTION_SKIPPED");
    } else if (selectedPodcasts.length === 0) {
      diagnosticCodes.push("EVENT_PODCAST_NO_FITTING_CANDIDATE");
    } else {
      diagnosticCodes.push("EVENT_PODCAST_SELECTED");
    }

    projectedBlocks.push({
      index: blockIndex,
      key: block.key,
      targetDurationMs,
      podcastUsableDurationMs,
      podcastAttempted,
      selectedPodcastUris: selectedPodcasts.map((candidate) => candidate.uri),
      selectedMusicUris,
      podcastDurationMs,
      musicDurationMs,
      filledDurationMs,
      deficitMs: Math.max(0, targetDurationMs - filledDurationMs),
      diagnosticCodes,
    });

    // Defensive assertion inside the pure projection: the selected slice for
    // this block can never exceed its own duration budget.
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
