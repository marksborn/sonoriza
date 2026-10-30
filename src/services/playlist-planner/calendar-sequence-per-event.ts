import type {
  CalendarEventCompositionPolicySnapshot,
  CalendarRemainderFillStrategyValue,
} from "../calendar-event-composition-policy";
import type {
  Calendar03EventCompositionShadow,
  Calendar03EventDiagnosticCode,
  Calendar03ProjectedBlock,
} from "./calendar-event-composition-shadow";
import { planPlaylist, type PlannerPools } from "./planner";
import type {
  Candidate,
  ContentType,
  DurationPlanningBlock,
  PlannedItem,
  PlaylistRules,
} from "./types";

export type Calendar04EventDiagnosticCode = Extract<
  Calendar03EventDiagnosticCode,
  `EVENT_SEQUENCE_${string}` | `EVENT_REMAINDER_${string}`
>;

export type Calendar04BlockEvidence = Readonly<{
  initialSequenceSlots: number;
  initialSequenceFilledSlots: number;
  initialMusicDurationMs: number;
  initialPodcastDurationMs: number;
  remainderAfterSequenceMs: number;
  remainderFillStrategy: CalendarRemainderFillStrategyValue;
  requestedRemainderPodcastPercent: number | null;
  remainderMusicDurationMs: number;
  remainderPodcastDurationMs: number;
  fallbackMusicDurationMs: number;
}>;

export type Calendar04ProjectedBlock = Calendar03ProjectedBlock &
  Readonly<{ calendar04: Calendar04BlockEvidence }>;

export type Calendar04SequencePerEventProjection = Omit<
  Calendar03EventCompositionShadow,
  "blocks"
> &
  Readonly<{ blocks: Calendar04ProjectedBlock[] }>;

export type ProjectCalendar04SequencePerEventInput = Readonly<{
  policy: CalendarEventCompositionPolicySnapshot;
  blocks: DurationPlanningBlock[];
  rules: PlaylistRules;
  pools: PlannerPools;
  reserved?: Iterable<string>;
  /**
   * KEEP_FILLED: valid items already in the remote playlist, in order. They
   * stay as a physical prefix of each event while they fit; see below.
   */
  preserved?: Candidate[];
}>;

/**
 * CALENDAR-04 (#532) — pure planner projection, no Spotify/database access.
 *
 * Every PER_EVENT block restarts the target's own sequence at slot 0 and tries
 * each slot once. An unfillable slot is skipped (never cut, never carried to the
 * next event). The time left after that first pass is filled with the chosen
 * remainder strategy; whatever is still empty may then be filled with music when
 * the policy allows it. All selection goes through the canonical planPlaylist
 * with strictDurationBoundary, so podcast order, show caps, diversity limits
 * and reservations are the same as in every other planning path and no item
 * crosses the event boundary.
 *
 * MIX_RATIO percentages are duration shares of the remainder only, and are a
 * target: whole episodes, real durations and available candidates may deviate.
 *
 * KEEP_FILLED: preserved items are consumed in remote order as the start of
 * each event while they fit (and, for podcasts, within the show cap). A
 * preserved item may open the next event only when the current one is exactly
 * full. At the first preserved item that cannot continue that prefix, it and
 * the whole remaining preserved suffix are dropped for this run and reserved,
 * so the writer removes them and they are never reselected as fresh content.
 * Preserved items count as the first slots of the event's sequence when their
 * types match the pattern in order; the first pass continues from there.
 */
export function projectCalendar04SequencePerEvent(
  input: ProjectCalendar04SequencePerEventInput,
): Calendar04SequencePerEventProjection {
  const settings = input.policy.sequencePerEvent;
  if (input.policy.eventCompositionPolicy !== "SEQUENCE_PER_EVENT" || !settings) {
    return emptyProjection("ABSTAIN_INHERIT_DESTINATION");
  }
  const pattern = input.rules.sequencePattern;
  if (input.rules.compositionMode !== "SEQUENCE" || pattern.length === 0) {
    return emptyProjection("ABSTAIN_NO_SEQUENCE_PATTERN");
  }
  if (input.blocks.length === 0) {
    return emptyProjection("ABSTAIN_NO_PER_EVENT_BLOCKS");
  }

  const reserved = new Set(input.reserved ?? []);
  const usedUris = new Set<string>();
  const selected: PlannedItem[] = [];
  const projectedBlocks: Calendar04ProjectedBlock[] = [];
  const preservedQueue = [...(input.preserved ?? [])];
  const programCounts = new Map<string, number>();
  const dropPreservedSuffix = () => {
    for (const item of preservedQueue.splice(0)) reserved.add(item.uri);
  };

  for (let blockIndex = 0; blockIndex < input.blocks.length; blockIndex += 1) {
    const block = input.blocks[blockIndex]!;
    const targetDurationMs = Math.max(0, block.targetDurationMs);
    const blockStart = selected.length;
    const diagnosticCodes: Calendar04EventDiagnosticCode[] = [];
    let filledMs = 0;

    const fill = (
      rules: Partial<PlaylistRules>,
      pools: PlannerPools,
      options: { maxSequenceSlots?: number } = {},
    ) => {
      const budgetMs = Math.max(0, targetDurationMs - filledMs);
      if (budgetMs === 0) return { musicMs: 0, podcastMs: 0, count: 0 };
      const result = planPlaylist({
        rules: { ...input.rules, ...rules, targetDurationMs: budgetMs },
        pools,
        reserved,
        constraintSeed: selected,
        strictDurationBoundary: true,
        ...options,
      });
      for (const item of result.items) {
        selected.push({
          ...item,
          position: selected.length,
          planningBlockIndex: blockIndex,
        });
      }
      for (const uri of result.usedUris) {
        reserved.add(uri);
        usedUris.add(uri);
      }
      filledMs += result.stats.totalDurationMs;
      return {
        musicMs: result.stats.musicDurationMs,
        podcastMs: result.stats.podcastDurationMs,
        count: result.items.length,
      };
    };

    // 0. KEEP_FILLED preserved prefix for this event.
    let initialFilledSlots = 0;
    let initialMusicMs = 0;
    let initialPodcastMs = 0;
    while (preservedQueue.length > 0) {
      const candidate = preservedQueue[0]!;
      const durationMs = Math.max(0, candidate.durationMs);
      if (filledMs >= targetDurationMs && blockIndex < input.blocks.length - 1) {
        break; // exact boundary: it may open the next event
      }
      const programId = candidate.type === "PODCAST" ? candidate.programId?.trim() : null;
      const overCap = Boolean(
        programId && (programCounts.get(programId) ?? 0) >= showCap(candidate, input.rules),
      );
      if (durationMs <= 0 || overCap || filledMs + durationMs > targetDurationMs) {
        dropPreservedSuffix();
        break;
      }
      preservedQueue.shift();
      selected.push({ ...candidate, position: selected.length, planningBlockIndex: blockIndex });
      reserved.add(candidate.uri);
      usedUris.add(candidate.uri);
      filledMs += durationMs;
      if (programId) programCounts.set(programId, (programCounts.get(programId) ?? 0) + 1);
      if (initialFilledSlots < pattern.length && candidate.type === pattern[initialFilledSlots]) {
        initialFilledSlots += 1;
        if (candidate.type === "MUSIC") initialMusicMs += durationMs;
        else initialPodcastMs += durationMs;
      }
    }
    if (blockIndex === input.blocks.length - 1) dropPreservedSuffix();
    // When the next preserved item opens the following event, this event is
    // exactly full and no fresh item may be inserted in front of it; every
    // fresh fill below then sees a zero budget and adds nothing.

    // 1. First pass of the sequence, one attempt per slot.
    for (const slotType of pattern.slice(initialFilledSlots)) {
      if (filledMs >= targetDurationMs) break;
      const slot = fill(
        { compositionMode: "SEQUENCE", sequencePattern: [slotType] },
        poolsOfType(input.pools, slotType),
        { maxSequenceSlots: 1 },
      );
      if (slot.count === 0) {
        pushUnique(
          diagnosticCodes,
          slotType === "PODCAST"
            ? "EVENT_SEQUENCE_SLOT_UNFILLED_PODCAST"
            : "EVENT_SEQUENCE_SLOT_UNFILLED_MUSIC",
        );
        continue;
      }
      initialFilledSlots += 1;
      initialMusicMs += slot.musicMs;
      initialPodcastMs += slot.podcastMs;
    }
    if (initialFilledSlots === pattern.length) {
      diagnosticCodes.push("EVENT_SEQUENCE_COMPLETED");
    }
    const remainderAfterSequenceMs = Math.max(0, targetDurationMs - filledMs);

    // 2. Remainder strategy.
    const remainder = fill(...remainderRequest(settings, pattern, input.pools));
    if (remainder.count > 0) diagnosticCodes.push("EVENT_REMAINDER_FILLED");

    // 3. Explicit fallback for the time that is still empty.
    let fallbackMusicMs = 0;
    if (
      filledMs < targetDurationMs &&
      settings.remainderFallback === "FILL_WITH_MUSIC" &&
      settings.remainderFillStrategy !== "MUSIC_ONLY"
    ) {
      const fallback = fill(
        { compositionMode: "PROPORTION", podcastPercent: 0 },
        poolsOfType(input.pools, "MUSIC"),
      );
      fallbackMusicMs = fallback.musicMs;
      if (fallback.count > 0) diagnosticCodes.push("EVENT_REMAINDER_FALLBACK_MUSIC");
    }

    const deficitMs = Math.max(0, targetDurationMs - filledMs);
    if (deficitMs > 0) diagnosticCodes.push("EVENT_REMAINDER_GAP_LEFT");
    if (filledMs > targetDurationMs) {
      throw new Error("CALENDAR-04 projection crossed an event duration boundary.");
    }

    const blockItems = selected.slice(blockStart);
    const musicDurationMs = sumDuration(blockItems.filter((item) => item.type === "MUSIC"));
    const podcastDurationMs = sumDuration(
      blockItems.filter((item) => item.type === "PODCAST"),
    );
    projectedBlocks.push({
      index: blockIndex,
      key: block.key,
      targetDurationMs,
      podcastUsableDurationMs: targetDurationMs,
      podcastAttempted: pattern.includes("PODCAST") ||
        settings.remainderFillStrategy === "PODCAST_ONLY" ||
        settings.remainderFillStrategy === "MIX_RATIO",
      selectedPodcastUris: blockItems
        .filter((item) => item.type === "PODCAST")
        .map((item) => item.uri),
      selectedMusicUris: blockItems
        .filter((item) => item.type === "MUSIC")
        .map((item) => item.uri),
      podcastDurationMs,
      musicDurationMs,
      filledDurationMs: filledMs,
      deficitMs,
      // A gap is an explicit, user-chosen outcome here, not a quality failure;
      // only an event that received nothing at all is flagged.
      musicCompositionQualityPassed: targetDurationMs === 0 || filledMs > 0,
      musicPoolExhausted: deficitMs > 0,
      diagnosticCodes,
      calendar04: {
        initialSequenceSlots: pattern.length,
        initialSequenceFilledSlots: initialFilledSlots,
        initialMusicDurationMs: initialMusicMs,
        initialPodcastDurationMs: initialPodcastMs,
        remainderAfterSequenceMs,
        remainderFillStrategy: settings.remainderFillStrategy,
        requestedRemainderPodcastPercent: settings.remainderPodcastPercent,
        remainderMusicDurationMs: remainder.musicMs,
        remainderPodcastDurationMs: remainder.podcastMs,
        fallbackMusicDurationMs: fallbackMusicMs,
      },
    });
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

function remainderRequest(
  settings: NonNullable<CalendarEventCompositionPolicySnapshot["sequencePerEvent"]>,
  pattern: ContentType[],
  pools: PlannerPools,
): [Partial<PlaylistRules>, PlannerPools] {
  switch (settings.remainderFillStrategy) {
    case "MUSIC_ONLY":
      return [{ compositionMode: "PROPORTION", podcastPercent: 0 }, poolsOfType(pools, "MUSIC")];
    case "PODCAST_ONLY":
      return [
        { compositionMode: "PROPORTION", podcastPercent: 100 },
        poolsOfType(pools, "PODCAST"),
      ];
    case "MIX_RATIO":
      return [
        {
          compositionMode: "PROPORTION",
          podcastPercent: settings.remainderPodcastPercent ?? 0,
        },
        pools,
      ];
    case "REPEAT_SEQUENCE":
      // Restarts at slot 0 inside this event only. planPlaylist stops at the
      // first slot it cannot fill, so the loop always terminates.
      return [{ compositionMode: "SEQUENCE", sequencePattern: pattern }, pools];
  }
}

function showCap(candidate: Candidate, rules: PlaylistRules): number {
  const targetCap = Math.max(1, Math.trunc(rules.maxEpisodesPerProgram || 1));
  const cap = candidate.podcastMaxEpisodesPerCycle;
  return Number.isInteger(cap) && Number(cap) >= 1 ? Math.min(targetCap, Number(cap)) : targetCap;
}

function poolsOfType(pools: PlannerPools, type: ContentType): PlannerPools {
  return type === "MUSIC"
    ? { music: pools.music, podcasts: [] }
    : { music: [], podcasts: pools.podcasts };
}

function pushUnique<T>(values: T[], value: T) {
  if (!values.includes(value)) values.push(value);
}

function sumDuration(items: readonly Candidate[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
}

function emptyProjection(
  status: Exclude<Calendar03EventCompositionShadow["status"], "READY_SHADOW">,
): Calendar04SequencePerEventProjection {
  return {
    status,
    policyVersion: "calendar03-gate2-shadow-v1",
    plannerInfluence: false,
    spotifyWrites: false,
    databaseWrites: false,
    items: [],
    usedUris: new Set<string>(),
    blocks: [],
  };
}
