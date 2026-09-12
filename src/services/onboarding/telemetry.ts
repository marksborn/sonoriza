import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  ONBOARDING_VERSION,
  type OnboardingStepValue,
} from "@/services/onboarding/state";

export const ONBOARDING_TELEMETRY_EVENTS = [
  "onboardingStarted",
  "stepCompleted",
  "stepFailed",
  "onboardingSkipped",
  "onboardingCompleted",
  "firstSimulationStarted",
  "firstSimulationSucceeded",
  "firstSimulationFailed",
  "firstActivationCompleted",
  "configurationAdjusted",
] as const;

export type OnboardingTelemetryEventName =
  (typeof ONBOARDING_TELEMETRY_EVENTS)[number];

const SAFE_METADATA_KEYS = new Set([
  "code",
  "provider",
  "operation",
  "outcome",
  "restart",
  "fromStep",
  "toStep",
  "runStatus",
]);

type SafeMetadataScalar =
  | string
  | number
  | boolean
  | null;

export function sanitizeOnboardingTelemetryMetadata(
  value:
    | Record<string, unknown>
    | null
    | undefined,
): Record<string, SafeMetadataScalar> | undefined {
  if (!value) return undefined;

  const safe: Record<
    string,
    SafeMetadataScalar
  > = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;

    if (
      raw === null ||
      typeof raw === "string" ||
      typeof raw === "number" ||
      typeof raw === "boolean"
    ) {
      safe[key] = raw;
    }
  }

  return Object.keys(safe).length > 0
    ? safe
    : undefined;
}

export function onboardingTelemetryEventData(
  input: {
    userId: string;
    event: OnboardingTelemetryEventName;
    step?: OnboardingStepValue | null;
    metadata?: Record<string, unknown> | null;
  },
): Prisma.OnboardingTelemetryEventUncheckedCreateInput {
  const metadata =
    sanitizeOnboardingTelemetryMetadata(
      input.metadata,
    );

  return {
    userId: input.userId,
    version: ONBOARDING_VERSION,
    event: input.event,
    step: input.step ?? undefined,
    ...(metadata
      ? {
          metadata:
            metadata as Prisma.InputJsonObject,
        }
      : {}),
  };
}

/**
 * Pilot telemetry must never block the user's onboarding.
 *
 * A telemetry storage problem is logged by event/step only:
 * no email, provider payload, playlist, track, calendar or token.
 */
export async function recordOnboardingTelemetry(
  input: {
    userId: string;
    event: OnboardingTelemetryEventName;
    step?: OnboardingStepValue | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await prisma.onboardingTelemetryEvent.create({
      data: onboardingTelemetryEventData(
        input,
      ),
    });
  } catch (error) {
    console.warn(
      "[ONBOARDING-01] telemetry write failed",
      {
        event: input.event,
        step: input.step ?? null,
        error:
          error instanceof Error
            ? error.name
            : "unknown",
      },
    );
  }
}
