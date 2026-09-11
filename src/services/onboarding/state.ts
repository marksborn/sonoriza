export const ONBOARDING_VERSION = 1 as const;

export const ONBOARDING_STEPS = [
  "WELCOME",
  "SPOTIFY",
  "SPOTIFY_HISTORY",
  "SOURCES",
  "DESTINATION",
  "MUSIC_BEHAVIOR",
  "CALENDAR",
  "REVIEW",
  "SIMULATION",
  "ACTIVATION",
] as const;

export type OnboardingStepValue = (typeof ONBOARDING_STEPS)[number];

export type OnboardingStatusValue =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "READY_FOR_SIMULATION"
  | "COMPLETED"
  | "SKIPPED";

export type OnboardingHistoryStatusValue =
  | "NOT_REQUESTED"
  | "REQUESTED"
  | "FILES_READY"
  | "IMPORTING"
  | "IMPORTED"
  | "FAILED";

const STATUS_TRANSITIONS: Readonly<
  Record<OnboardingStatusValue, readonly OnboardingStatusValue[]>
> = {
  NOT_STARTED: ["IN_PROGRESS", "SKIPPED"],
  IN_PROGRESS: ["READY_FOR_SIMULATION", "SKIPPED"],
  READY_FOR_SIMULATION: ["IN_PROGRESS", "COMPLETED", "SKIPPED"],
  COMPLETED: ["IN_PROGRESS"],
  SKIPPED: ["IN_PROGRESS"],
};

const HISTORY_TRANSITIONS: Readonly<
  Record<OnboardingHistoryStatusValue, readonly OnboardingHistoryStatusValue[]>
> = {
  NOT_REQUESTED: ["REQUESTED", "FILES_READY"],
  REQUESTED: ["FILES_READY", "FAILED"],
  FILES_READY: ["IMPORTING", "FAILED"],
  IMPORTING: ["IMPORTED", "FAILED"],
  IMPORTED: ["FILES_READY"],
  FAILED: ["REQUESTED", "FILES_READY"],
};

export function onboardingStepIndex(step: OnboardingStepValue) {
  return ONBOARDING_STEPS.indexOf(step);
}

export function nextOnboardingStep(
  step: OnboardingStepValue,
): OnboardingStepValue | null {
  const index = onboardingStepIndex(step);

  if (index < 0 || index >= ONBOARDING_STEPS.length - 1) {
    return null;
  }

  return ONBOARDING_STEPS[index + 1] ?? null;
}

export function previousOnboardingStep(
  step: OnboardingStepValue,
): OnboardingStepValue | null {
  const index = onboardingStepIndex(step);

  if (index <= 0) {
    return null;
  }

  return ONBOARDING_STEPS[index - 1] ?? null;
}

export function canTransitionOnboardingStatus(
  from: OnboardingStatusValue,
  to: OnboardingStatusValue,
) {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function canTransitionOnboardingHistoryStatus(
  from: OnboardingHistoryStatusValue,
  to: OnboardingHistoryStatusValue,
) {
  return HISTORY_TRANSITIONS[from].includes(to);
}

export function historyWaitBlocksOnboarding(
  _historyStatus: OnboardingHistoryStatusValue,
) {
  return false;
}
