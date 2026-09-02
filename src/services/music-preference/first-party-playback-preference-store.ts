import {
  FirstPartyPreferenceSource as PrismaFirstPartyPreferenceSource,
  PlaybackPreferencePolicy as PrismaPlaybackPreferencePolicy,
  PlaybackPreferenceSubjectType as PrismaPlaybackPreferenceSubjectType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  normalizeFirstPartyPreferenceSubjectKey,
  normalizeSetFirstPartyPlaybackPreferenceInput,
  type FirstPartyPlaybackPreference,
  type FirstPartyPreferenceSource,
  type PlaybackPreferencePolicy,
  type PlaybackPreferenceSubjectType,
  type SetFirstPartyPlaybackPreferenceInput,
} from "./first-party-playback-preference";

export type FirstPartyPlaybackPreferenceStore = Readonly<{
  set(
    input: SetFirstPartyPlaybackPreferenceInput,
  ): Promise<FirstPartyPlaybackPreference>;
  list(
    userId: string,
    subjectType?: PlaybackPreferenceSubjectType,
  ): Promise<FirstPartyPlaybackPreference[]>;
  remove(
    userId: string,
    subjectType: PlaybackPreferenceSubjectType,
    subjectKey: string,
  ): Promise<boolean>;
}>;

const PRISMA_SOURCE = {
  USER_EXPLICIT: PrismaFirstPartyPreferenceSource.USER_EXPLICIT,
  SONORIZA_INTERACTION: PrismaFirstPartyPreferenceSource.SONORIZA_INTERACTION,
} as const satisfies Readonly<
  Record<FirstPartyPreferenceSource, PrismaFirstPartyPreferenceSource>
>;

const PRISMA_SUBJECT_TYPE = {
  TRACK: PrismaPlaybackPreferenceSubjectType.TRACK,
  ARTIST: PrismaPlaybackPreferenceSubjectType.ARTIST,
  VERSION_TRAIT: PrismaPlaybackPreferenceSubjectType.VERSION_TRAIT,
  DISCOVERY: PrismaPlaybackPreferenceSubjectType.DISCOVERY,
  REPEAT: PrismaPlaybackPreferenceSubjectType.REPEAT,
} as const satisfies Readonly<
  Record<PlaybackPreferenceSubjectType, PrismaPlaybackPreferenceSubjectType>
>;

const PRISMA_POLICY = {
  PREFERRED: PrismaPlaybackPreferencePolicy.PREFERRED,
  NORMAL: PrismaPlaybackPreferencePolicy.NORMAL,
  REDUCED: PrismaPlaybackPreferencePolicy.REDUCED,
  EXCLUDED: PrismaPlaybackPreferencePolicy.EXCLUDED,
} as const satisfies Readonly<
  Record<PlaybackPreferencePolicy, PrismaPlaybackPreferencePolicy>
>;

function fromPrismaRow(row: {
  id: string;
  userId: string;
  subjectType: PrismaPlaybackPreferenceSubjectType;
  subjectKey: string;
  policy: PrismaPlaybackPreferencePolicy;
  source: PrismaFirstPartyPreferenceSource;
  createdAt: Date;
  updatedAt: Date;
}): FirstPartyPlaybackPreference {
  return Object.freeze({
    id: row.id,
    userId: row.userId,
    subjectType: row.subjectType,
    subjectKey: row.subjectKey,
    policy: row.policy,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

const SELECT_FIRST_PARTY_PREFERENCE = {
  id: true,
  userId: true,
  subjectType: true,
  subjectKey: true,
  policy: true,
  source: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Persistence adapter for Gate 4.
 *
 * It touches only FirstPartyPlaybackPreference. It does not read/write
 * LikedTrackPreference, ArtistAffinityState, MusicPreferenceSignal,
 * TrackListeningEvent or any provider API.
 */
export const prismaFirstPartyPlaybackPreferenceStore: FirstPartyPlaybackPreferenceStore = {
  async set(input) {
    const normalized = normalizeSetFirstPartyPlaybackPreferenceInput(input);
    const subjectType = PRISMA_SUBJECT_TYPE[normalized.subjectType];

    const row = await prisma.firstPartyPlaybackPreference.upsert({
      where: {
        userId_subjectType_subjectKey: {
          userId: normalized.userId,
          subjectType,
          subjectKey: normalized.subjectKey,
        },
      },
      create: {
        userId: normalized.userId,
        subjectType,
        subjectKey: normalized.subjectKey,
        policy: PRISMA_POLICY[normalized.policy],
        source: PRISMA_SOURCE[normalized.source],
      },
      update: {
        policy: PRISMA_POLICY[normalized.policy],
        source: PRISMA_SOURCE[normalized.source],
      },
      select: SELECT_FIRST_PARTY_PREFERENCE,
    });

    return fromPrismaRow(row);
  },

  async list(userId, subjectType) {
    const rows = await prisma.firstPartyPlaybackPreference.findMany({
      where: {
        userId,
        ...(subjectType
          ? { subjectType: PRISMA_SUBJECT_TYPE[subjectType] }
          : {}),
      },
      orderBy: [{ subjectType: "asc" }, { subjectKey: "asc" }],
      select: SELECT_FIRST_PARTY_PREFERENCE,
    });

    return rows.map(fromPrismaRow);
  },

  async remove(userId, subjectType, subjectKey) {
    const normalizedKey = normalizeFirstPartyPreferenceSubjectKey(subjectKey);

    const result = await prisma.firstPartyPlaybackPreference.deleteMany({
      where: {
        userId,
        subjectType: PRISMA_SUBJECT_TYPE[subjectType],
        subjectKey: normalizedKey,
      },
    });

    return result.count > 0;
  },
};
