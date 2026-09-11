import {
  ONBOARDING_STEPS,
  type OnboardingStepValue,
} from "./state";

export const GATE2_LAST_IMPLEMENTED_STEP = "SPOTIFY" as const;

export function onboardingProgressPosition(step: OnboardingStepValue) {
  const index = ONBOARDING_STEPS.indexOf(step);

  return {
    current: Math.max(index, 0) + 1,
    total: ONBOARDING_STEPS.length,
  };
}

export function gate2CanAdvance(step: OnboardingStepValue) {
  return step === "WELCOME";
}

export function gate2NextStep(
  step: OnboardingStepValue,
): OnboardingStepValue | null {
  if (step === "WELCOME") return "SPOTIFY";
  return null;
}

export function gate2CanGoBack(step: OnboardingStepValue) {
  return step === "SPOTIFY";
}

export function gate2PreviousStep(
  step: OnboardingStepValue,
): OnboardingStepValue | null {
  if (step === "SPOTIFY") return "WELCOME";
  return null;
}

export function readPersistedStepList(value: unknown): OnboardingStepValue[] {
  if (!Array.isArray(value)) return [];

  const allowed = new Set<string>(ONBOARDING_STEPS);

  return [
    ...new Set(
      value.filter(
        (item): item is OnboardingStepValue =>
          typeof item === "string" && allowed.has(item),
      ),
    ),
  ];
}

export function appendPersistedStep(
  value: unknown,
  step: OnboardingStepValue,
): OnboardingStepValue[] {
  return [...new Set([...readPersistedStepList(value), step])];
}
