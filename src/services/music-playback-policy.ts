import { MusicRepeatWindowUnit } from "@prisma/client";

import { prisma } from "@/lib/prisma";

export type MusicPlaybackPolicyInput = {
  enabled: boolean;
  windowValue: number;
  windowUnit: MusicRepeatWindowUnit;
};

export function normalizeMusicPlaybackPolicyInput(
  input: MusicPlaybackPolicyInput,
): MusicPlaybackPolicyInput {
  if (
    !Number.isInteger(input.windowValue) ||
    input.windowValue < 1
  ) {
    throw new Error("invalid-music-repeat-window");
  }

  if (
    input.windowUnit !== MusicRepeatWindowUnit.DAYS &&
    input.windowUnit !== MusicRepeatWindowUnit.MONTHS &&
    input.windowUnit !== MusicRepeatWindowUnit.YEARS
  ) {
    throw new Error("invalid-music-repeat-unit");
  }

  return {
    enabled: input.enabled,
    windowValue: input.windowValue,
    windowUnit: input.windowUnit,
  };
}

export async function saveMusicPlaybackPolicyForUser(
  userId: string,
  input: MusicPlaybackPolicyInput,
) {
  const data = normalizeMusicPlaybackPolicyInput(input);

  return prisma.musicPlaybackPolicy.upsert({
    where: { userId },
    create: {
      userId,
      ...data,
    },
    update: data,
  });
}
