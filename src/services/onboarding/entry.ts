import { prisma } from "@/lib/prisma";

export type OnboardingEntryState =
  Readonly<{
    status:
      | "NOT_STARTED"
      | "IN_PROGRESS"
      | "READY_FOR_SIMULATION"
      | "COMPLETED"
      | "SKIPPED"
      | null;
    targetCount: number;
    sourceCount: number;
  }>;

export function shouldEnterOnboardingFromState(
  state: OnboardingEntryState,
): boolean {
  if (
    state.status === "COMPLETED" ||
    state.status === "SKIPPED"
  ) {
    return false;
  }

  if (state.status !== null) {
    return true;
  }

  // Preserve legacy configured users that predate
  // ONBOARDING-01. A genuinely new Auth.js account has
  // neither sources nor destinations and should enter
  // the guided flow.
  return (
    state.targetCount === 0 &&
    state.sourceCount === 0
  );
}

export async function shouldEnterOnboarding(
  userId: string,
): Promise<boolean> {
  const [progress, targetCount, sourceCount] =
    await Promise.all([
      prisma.onboardingProgress.findUnique({
        where: { userId },
        select: {
          status: true,
        },
      }),

      prisma.targetPlaylist.count({
        where: { userId },
      }),

      prisma.sourcePlaylist.count({
        where: { userId },
      }),
    ]);

  return shouldEnterOnboardingFromState({
    status: progress?.status ?? null,
    targetCount,
    sourceCount,
  });
}
