import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CalendarEventCompositionPolicySnapshot,
} from "@/services/calendar-event-composition-policy";

import type { Calendar03EventCompositionShadow } from "./calendar-event-composition-shadow";

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
  targets: Calendar03RuntimeTargetEvidence[];
}>;

export type Calendar03PlannerRuntimeState = {
  policies: ReadonlyMap<string, CalendarEventCompositionPolicySnapshot>;
  requestedMode: Calendar03PlannerMode;
  effectiveMode: Calendar03PlannerMode;
  activationReason: Calendar03PlannerActivationReason;
  activeTargetAllowlist: ReadonlySet<string>;
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
}): Calendar03PlannerRuntimeState {
  const mode = resolveCalendar03PlannerMode(input);
  return {
    policies: input.policies,
    ...mode,
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
        (policy) => policy.eventCompositionPolicy === "PODCAST_THEN_MUSIC",
      ).length,
      activeTargetAllowlist: [...mode.activeTargetAllowlist].sort(),
      targets: [],
    },
  };
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
