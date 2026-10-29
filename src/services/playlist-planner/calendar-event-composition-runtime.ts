import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CalendarEventCompositionPolicySnapshot,
} from "@/services/calendar-event-composition-policy";

import type { Calendar03EventCompositionShadow } from "./calendar-event-composition-shadow";
import type { Calendar04BlockEvidence } from "./calendar-sequence-per-event";

export type Calendar03PlannerMode = "OFF" | "SHADOW" | "ACTIVE";

export type Calendar03PlannerActivationReason =
  | "MODE_OFF"
  | "MODE_SHADOW"
  | "ACTIVE_ALLOWED"
  | "ACTIVE_EMAIL_NOT_ALLOWED"
  | "ACTIVE_TARGET_NOT_ALLOWED"
  | "INVALID_MODE";

export type Calendar03RuntimeTargetEvidence = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  policy: CalendarEventCompositionPolicySnapshot;
  status:
    | Calendar03EventCompositionShadow["status"]
    | "ABSTAIN_TARGET_NOT_ALLOWED"
    | "ABSTAIN_MULTI_TARGET_ACTIVE_SCOPE"
    | "ABSTAIN_PRESERVED_ITEMS";
  plannerInfluence: boolean;
  selectedPodcastUris: string[];
  blockDiagnostics: Array<{
    index: number;
    key: string;
    targetDurationMs: number;
    podcastUsableDurationMs: number;
    diagnosticCodes: string[];
    /** CALENDAR-04 only: per-event fill evidence for the preview. */
    filledDurationMs?: number;
    deficitMs?: number;
    musicDurationMs?: number;
    podcastDurationMs?: number;
    calendar04?: Calendar04BlockEvidence;
  }>;
}>;

export type Calendar03PlannerRuntimeSummary = Readonly<{
  runtimeVersion: "calendar03-gate3-runtime-v1";
  policyVersion: "calendar03-gate2-shadow-v1";
  requestedMode: Calendar03PlannerMode;
  effectiveMode: Calendar03PlannerMode;
  activationReason: Calendar03PlannerActivationReason;
  plannerInfluence: boolean;
  databaseWrites: false;
  spotifyWrites: false;
  configuredPolicyCount: number;
  activeTargetAllowlist: string[];
  /** CALENDAR-04 (#532): own kill switch on top of the CALENDAR-03 gate. */
  calendar04RequestedMode?: Calendar03PlannerMode;
  calendar04EffectiveMode?: Calendar03PlannerMode;
  targets: Calendar03RuntimeTargetEvidence[];
}>;

export type Calendar03PlannerRuntimeState = {
  policies: ReadonlyMap<string, CalendarEventCompositionPolicySnapshot>;
  requestedMode: Calendar03PlannerMode;
  effectiveMode: Calendar03PlannerMode;
  activationReason: Calendar03PlannerActivationReason;
  activeTargetAllowlist: ReadonlySet<string>;
  /**
   * CALENDAR-04 can only be ACTIVE when CALENDAR-03 is ACTIVE for the target
   * (same email/target allowlists) and CALENDAR_04_PLANNER_MODE=ACTIVE.
   */
  calendar04Mode: Calendar03PlannerMode;
  evidence: Calendar03PlannerRuntimeSummary;
};

const storage = new AsyncLocalStorage<Calendar03PlannerRuntimeState>();

export function resolveCalendar03PlannerMode(input: {
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
  activeTargetIds?: string | null;
}): Pick<
  Calendar03PlannerRuntimeState,
  | "requestedMode"
  | "effectiveMode"
  | "activationReason"
  | "activeTargetAllowlist"
> {
  const rawMode = normalizedOptionalText(input.requestedMode)?.toUpperCase() ?? null;
  if (rawMode !== null && !["OFF", "SHADOW", "ACTIVE"].includes(rawMode)) {
    return {
      requestedMode: "OFF",
      effectiveMode: "OFF",
      activationReason: "INVALID_MODE",
      activeTargetAllowlist: new Set(),
    };
  }

  const requestedMode = (rawMode ?? "SHADOW") as Calendar03PlannerMode;
  const activeTargetAllowlist = parseList(input.activeTargetIds, false);
  if (requestedMode === "OFF") {
    return {
      requestedMode,
      effectiveMode: "OFF",
      activationReason: "MODE_OFF",
      activeTargetAllowlist,
    };
  }
  if (requestedMode === "SHADOW") {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "MODE_SHADOW",
      activeTargetAllowlist,
    };
  }

  const userEmail = normalizedOptionalText(input.userEmail)?.toLowerCase() ?? null;
  const activeEmailAllowlist = parseList(input.activeEmailAllowlist, true);
  if (!userEmail || !activeEmailAllowlist.has(userEmail)) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_EMAIL_NOT_ALLOWED",
      activeTargetAllowlist,
    };
  }
  if (activeTargetAllowlist.size === 0) {
    return {
      requestedMode,
      effectiveMode: "SHADOW",
      activationReason: "ACTIVE_TARGET_NOT_ALLOWED",
      activeTargetAllowlist,
    };
  }
  return {
    requestedMode,
    effectiveMode: "ACTIVE",
    activationReason: "ACTIVE_ALLOWED",
    activeTargetAllowlist,
  };
}

export function createCalendar03PlannerRuntimeState(input: {
  policies: ReadonlyMap<string, CalendarEventCompositionPolicySnapshot>;
  requestedMode?: string | null;
  userEmail?: string | null;
  activeEmailAllowlist?: string | null;
  activeTargetIds?: string | null;
  /** Defaults to CALENDAR_04_PLANNER_MODE so every trigger shares one switch. */
  calendar04RequestedMode?: string | null;
}): Calendar03PlannerRuntimeState {
  const mode = resolveCalendar03PlannerMode(input);
  const calendar04 = resolveCalendar04PlannerMode(
    input.calendar04RequestedMode === undefined
      ? process.env.CALENDAR_04_PLANNER_MODE
      : input.calendar04RequestedMode,
    mode.effectiveMode,
  );
  const hasCalendar04Policy = [...input.policies.values()].some(
    (policy) => policy.eventCompositionPolicy === "SEQUENCE_PER_EVENT",
  );
  return {
    policies: input.policies,
    ...mode,
    calendar04Mode: calendar04.effectiveMode,
    evidence: {
      runtimeVersion: "calendar03-gate3-runtime-v1",
      policyVersion: "calendar03-gate2-shadow-v1",
      requestedMode: mode.requestedMode,
      effectiveMode: mode.effectiveMode,
      activationReason: mode.activationReason,
      plannerInfluence: false,
      databaseWrites: false,
      spotifyWrites: false,
      configuredPolicyCount: [...input.policies.values()].filter(
        (policy) =>
          policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC" ||
          policy.eventCompositionPolicy === "SEQUENCE_PER_EVENT",
      ).length,
      activeTargetAllowlist: [...mode.activeTargetAllowlist].sort(),
      // Only surfaced when a target uses CALENDAR-04, so legacy evidence keeps
      // its exact shape.
      ...(hasCalendar04Policy
        ? {
            calendar04RequestedMode: calendar04.requestedMode,
            calendar04EffectiveMode: calendar04.effectiveMode,
          }
        : {}),
      targets: [],
    },
  };
}

export function resolveCalendar04PlannerMode(
  rawRequestedMode: string | null | undefined,
  calendar03EffectiveMode: Calendar03PlannerMode,
): { requestedMode: Calendar03PlannerMode; effectiveMode: Calendar03PlannerMode } {
  const raw = normalizedOptionalText(rawRequestedMode)?.toUpperCase() ?? "SHADOW";
  const requestedMode: Calendar03PlannerMode =
    raw === "OFF" || raw === "ACTIVE" ? raw : "SHADOW";
  if (requestedMode === "OFF" || calendar03EffectiveMode === "OFF") {
    return { requestedMode, effectiveMode: "OFF" };
  }
  return {
    requestedMode,
    effectiveMode:
      requestedMode === "ACTIVE" && calendar03EffectiveMode === "ACTIVE"
        ? "ACTIVE"
        : "SHADOW",
  };
}

/** True when this target's persisted policy may replace the legacy plan. */
export function calendarCompositionTargetIsActive(
  state: Calendar03PlannerRuntimeState,
  policy: CalendarEventCompositionPolicySnapshot | undefined,
): boolean {
  if (!policy) return false;
  if (!calendar03TargetIsActive(state, policy.targetPlaylistId)) return false;
  if (policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC") return true;
  return (
    policy.eventCompositionPolicy === "SEQUENCE_PER_EVENT" &&
    state.calendar04Mode === "ACTIVE"
  );
}

export function runWithCalendar03PlannerRuntimeState<T>(
  state: Calendar03PlannerRuntimeState,
  callback: () => T,
): T {
  return storage.run(state, callback);
}

export function currentCalendar03PlannerRuntimeState():
  | Calendar03PlannerRuntimeState
  | undefined {
  return storage.getStore();
}

export function calendar03TargetIsActive(
  state: Calendar03PlannerRuntimeState,
  targetPlaylistId: string,
): boolean {
  return (
    state.effectiveMode === "ACTIVE" &&
    state.activeTargetAllowlist.has(targetPlaylistId)
  );
}

/**
 * Returns true only when CALENDAR-03 ACTIVE actually replaced the legacy
 * composition for this exact target. Pre-write guards may use this as narrow
 * ownership evidence; SHADOW, abstentions and uninfluenced ACTIVE runs must
 * continue to use the legacy target contract.
 */
export function calendar03TargetOwnsComposition(
  state: Calendar03PlannerRuntimeState,
  targetPlaylistId: string,
): boolean {
  if (state.effectiveMode !== "ACTIVE") return false;
  if (!state.activeTargetAllowlist.has(targetPlaylistId)) return false;

  const evidence = state.evidence.targets.find(
    (target) => target.targetPlaylistId === targetPlaylistId,
  );

  return (
    evidence?.status === "READY_SHADOW" &&
    evidence.plannerInfluence === true
  );
}

export function recordCalendar03RuntimeTargets(
  state: Calendar03PlannerRuntimeState,
  targets: Calendar03RuntimeTargetEvidence[],
): void {
  const plannerInfluence = targets.some((target) => target.plannerInfluence);
  state.evidence = {
    ...state.evidence,
    plannerInfluence,
    targets,
  };
}

export function calendar03PlannerRuntimeSummary(
  state: Calendar03PlannerRuntimeState,
): Calendar03PlannerRuntimeSummary {
  return state.evidence;
}

function parseList(value: string | null | undefined, lowerCase: boolean) {
  return new Set(
    (value ?? "")
      .split(/[,;\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (lowerCase ? entry.toLowerCase() : entry)),
  );
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}
