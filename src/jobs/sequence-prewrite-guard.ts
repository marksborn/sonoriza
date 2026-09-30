import { currentPlaybackReserveShadowRuntimeState } from "@/services/playback-reserve-shadow-runtime";
import { parseSequencePattern } from "@/services/playlist-planner";
import {
  calendar03TargetOwnsComposition,
  currentCalendar03PlannerRuntimeState,
} from "@/services/playlist-planner/calendar-event-composition-runtime";

export type SequencePrewriteViolation = {
  targetPlaylistId: string;
  targetName: string;
  reason: "INVALID_PATTERN" | "TYPE_MISMATCH";
  position?: number;
};

type SequenceTarget = {
  id: string;
  name: string;
  compositionMode: string;
  sequencePattern: unknown;
};

type SequencePlannedItem = {
  type: "MUSIC" | "PODCAST";
  position: number;
  uri: string;
};

type SequencePlannedTarget = {
  targetPlaylistId: string;
  result: {
    items: SequencePlannedItem[];
  };
};

/**
 * Final pre-write sequence guard.
 *
 * Legacy SEQUENCE targets keep the exact existing protection. CALENDAR-03 may
 * own the complete PRIMARY composition when its ACTIVE runtime proves planner
 * influence for the exact target.
 *
 * PLAYBACK-RESERVE is different: its ACTIVE contract appends a semantically
 * separate RESERVE suffix after PRIMARY. The persisted destination sequence is
 * therefore authoritative only for PRIMARY. We exclude a reserve suffix from
 * this legacy guard only when the current runtime evidence proves the exact
 * PRIMARY/RESERVE boundary and every selected reserve item matches the physical
 * suffix by URI, type and position. Any absent/stale/inconsistent evidence falls
 * back to validating the entire plan (fail closed).
 */
export function sequencePrewriteViolations(
  plannedTargets: SequencePlannedTarget[],
  targetByPlanId: ReadonlyMap<string, SequenceTarget>,
): SequencePrewriteViolation[] {
  const calendar03State = currentCalendar03PlannerRuntimeState();
  const violations: SequencePrewriteViolation[] = [];

  for (const planned of plannedTargets) {
    const target = targetByPlanId.get(planned.targetPlaylistId);
    if (!target || target.compositionMode !== "SEQUENCE") continue;

    if (
      calendar03State &&
      calendar03TargetOwnsComposition(calendar03State, planned.targetPlaylistId)
    ) {
      continue;
    }

    const pattern = parseSequencePattern(target.sequencePattern);
    if (pattern.length === 0) {
      violations.push({
        targetPlaylistId: target.id,
        targetName: target.name,
        reason: "INVALID_PATTERN",
      });
      continue;
    }

    const sequenceOwnedItems = primaryItemsForLegacySequenceGuard(planned);
    const mismatch = sequenceOwnedItems.find(
      (item, index) => item.type !== pattern[index % pattern.length],
    );

    if (mismatch) {
      violations.push({
        targetPlaylistId: target.id,
        targetName: target.name,
        reason: "TYPE_MISMATCH",
        position: mismatch.position,
      });
    }
  }

  return violations;
}

function primaryItemsForLegacySequenceGuard(
  planned: SequencePlannedTarget,
): SequencePlannedItem[] {
  const state = currentPlaybackReserveShadowRuntimeState();
  if (
    !state ||
    state.effectiveMode !== "ACTIVE" ||
    !state.plannerInfluence ||
    !state.evidence ||
    state.evidence.mode !== "ACTIVE" ||
    !state.evidence.plannerInfluence
  ) {
    return planned.result.items;
  }

  const evidence = state.evidence.targets.find(
    (target) => target.targetPlaylistId === planned.targetPlaylistId,
  );
  if (!evidence?.reserve) return planned.result.items;

  const primaryItemCount = evidence.primary.itemCount;
  const selectedReserveItems = evidence.reserve.selectedItems;
  if (
    !Number.isInteger(primaryItemCount) ||
    primaryItemCount < 0 ||
    primaryItemCount > planned.result.items.length ||
    selectedReserveItems.length === 0 ||
    primaryItemCount + selectedReserveItems.length !== planned.result.items.length
  ) {
    return planned.result.items;
  }

  for (let index = 0; index < selectedReserveItems.length; index += 1) {
    const selected = selectedReserveItems[index];
    const physical = planned.result.items[primaryItemCount + index];
    if (
      !selected ||
      !physical ||
      selected.uri !== physical.uri ||
      selected.type !== physical.type ||
      selected.position !== physical.position
    ) {
      return planned.result.items;
    }
  }

  return planned.result.items.slice(0, primaryItemCount);
}
