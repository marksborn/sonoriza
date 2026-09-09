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

type SequencePlannedTarget = {
  targetPlaylistId: string;
  result: {
    items: Array<{
      type: "MUSIC" | "PODCAST";
      position: number;
    }>;
  };
};

/**
 * Final pre-write sequence guard.
 *
 * Legacy SEQUENCE targets keep the exact existing protection. The only narrow
 * exception is when the current CALENDAR-03 runtime proves that ACTIVE actually
 * owns composition for this exact target (READY_SHADOW + plannerInfluence).
 * SHADOW, abstentions, uninfluenced ACTIVE runs and every other target remain
 * subject to the persisted legacy sequencePattern.
 */
export function sequencePrewriteViolations(
  plannedTargets: SequencePlannedTarget[],
  targetByPlanId: ReadonlyMap<string, SequenceTarget>,
): SequencePrewriteViolation[] {
  const calendar03State = currentCalendar03PlannerRuntimeState();

  return plannedTargets.flatMap((planned) => {
    const target = targetByPlanId.get(planned.targetPlaylistId);
    if (!target || target.compositionMode !== "SEQUENCE") return [];

    if (
      calendar03State &&
      calendar03TargetOwnsComposition(calendar03State, planned.targetPlaylistId)
    ) {
      return [];
    }

    const pattern = parseSequencePattern(target.sequencePattern);
    if (pattern.length === 0) {
      return [
        {
          targetPlaylistId: target.id,
          targetName: target.name,
          reason: "INVALID_PATTERN" as const,
        },
      ];
    }

    const mismatch = planned.result.items.find(
      (item, index) => item.type !== pattern[index % pattern.length],
    );

    return mismatch
      ? [
          {
            targetPlaylistId: target.id,
            targetName: target.name,
            reason: "TYPE_MISMATCH" as const,
            position: mismatch.position,
          },
        ]
      : [];
  });
}
