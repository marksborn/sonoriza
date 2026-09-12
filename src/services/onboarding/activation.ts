import { prisma } from "@/lib/prisma";
import {
  assessCalendar03GenerationConfiguration,
} from "@/services/calendar-event-composition-generation";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import {
  loadLatestOnboardingSimulation,
} from "@/services/onboarding/simulation";
import {
  ONBOARDING_VERSION,
} from "@/services/onboarding/state";
import {
  appendPersistedStep,
} from "@/services/onboarding/shell";

export type OnboardingActivationErrorCode =
  | "no-target"
  | "invalid-state"
  | "simulation-not-approved"
  | "conflict";

export class OnboardingActivationError
  extends Error {
  constructor(
    readonly code:
      OnboardingActivationErrorCode,
  ) {
    super(code);
    this.name =
      "OnboardingActivationError";
  }
}

export async function activateOnboardingTarget(
  input: {
    userId: string;
    targetId: string;
  },
) {
  const [target, progress] =
    await Promise.all([
      prisma.targetPlaylist.findFirst({
        where: {
          id: input.targetId,
          userId: input.userId,
        },
        select: {
          id: true,
        },
      }),

      prisma.onboardingProgress.findUnique({
        where: {
          userId: input.userId,
        },
      }),
    ]);

  if (!target) {
    throw new OnboardingActivationError(
      "no-target",
    );
  }

  if (
    !progress ||
    progress.status !==
      "READY_FOR_SIMULATION" ||
    progress.currentStep !== "SIMULATION"
  ) {
    throw new OnboardingActivationError(
      "invalid-state",
    );
  }

  const simulation =
    await loadLatestOnboardingSimulation(
      input.userId,
      input.targetId,
    );

  if (
    !simulation ||
    simulation.status !== "SUCCESS" ||
    !simulation.qualityPassed ||
    !simulation.collectionComplete ||
    simulation.inconclusive ||
    Boolean(simulation.error)
  ) {
    throw new OnboardingActivationError(
      "simulation-not-approved",
    );
  }

  const baseAssessment =
    await assessConfiguration(
      input.userId,
      {
        targetPlaylistIds: [
          input.targetId,
        ],
        includeDisabledTargetIds: [
          input.targetId,
        ],
      },
    );

  const calendar03 =
    await assessCalendar03GenerationConfiguration(
      input.userId,
      baseAssessment,
    );

  const gate =
    await getFirstRunGate(
      input.userId,
      calendar03.assessment,
    );

  if (!gate.realRunAllowed) {
    throw new OnboardingActivationError(
      "simulation-not-approved",
    );
  }

  const now = new Date();

  const completedSteps =
    appendPersistedStep(
      appendPersistedStep(
        progress.completedSteps,
        "SIMULATION",
      ),
      "ACTIVATION",
    );

  await prisma.$transaction(
    async (tx) => {
      const targetUpdated =
        await tx.targetPlaylist.updateMany({
          where: {
            id: input.targetId,
            userId: input.userId,
          },
          data: {
            enabled: true,
          },
        });

      if (targetUpdated.count !== 1) {
        throw new OnboardingActivationError(
          "conflict",
        );
      }

      const progressUpdated =
        await tx.onboardingProgress.updateMany({
          where: {
            userId: input.userId,
            status:
              "READY_FOR_SIMULATION",
            currentStep: "SIMULATION",
          },
          data: {
            version:
              ONBOARDING_VERSION,
            status: "COMPLETED",
            currentStep: "ACTIVATION",
            completedSteps,
            completedAt: now,
            skippedAt: null,
          },
        });

      if (progressUpdated.count !== 1) {
        throw new OnboardingActivationError(
          "conflict",
        );
      }
    },
  );

  return {
    targetId: input.targetId,
    completedAt: now,
  };
}
