import { prisma } from "@/lib/prisma";

import {
  DEFAULT_PODCAST_SHOW_PRIORITY,
  normalizePodcastShowCadence,
  type PodcastCadenceUnitValue,
  type PodcastShowPriorityValue,
} from "./podcast-show-cadence-contract";

export type PodcastShowCadencePolicySnapshot = {
  spotifyShowId: string;
  showName: string | null;
  cadenceMaxEpisodes: number | null;
  cadenceUnit: PodcastCadenceUnitValue | null;
  priority: PodcastShowPriorityValue;
};

export type PodcastShowCadencePolicyUpdate = {
  showName?: string | null;
  cadenceMaxEpisodes?: number | null;
  cadenceUnit?: PodcastCadenceUnitValue | null;
  priority?: PodcastShowPriorityValue;
};

export function podcastShowCadencePolicyUpdateRequested(
  input: PodcastShowCadencePolicyUpdate,
): boolean {
  return (
    input.showName !== undefined ||
    input.cadenceMaxEpisodes !== undefined ||
    input.cadenceUnit !== undefined ||
    input.priority !== undefined
  );
}

export function resolvePodcastShowCadencePolicyUpdate(
  spotifyShowId: string,
  existing: PodcastShowCadencePolicySnapshot | null,
  input: PodcastShowCadencePolicyUpdate,
): PodcastShowCadencePolicySnapshot {
  const normalizedShowId = normalizedRequiredId(spotifyShowId, "spotifyShowId");
  const cadence = normalizePodcastShowCadence({
    cadenceMaxEpisodes:
      input.cadenceMaxEpisodes === undefined
        ? existing?.cadenceMaxEpisodes ?? null
        : input.cadenceMaxEpisodes,
    cadenceUnit:
      input.cadenceUnit === undefined
        ? existing?.cadenceUnit ?? null
        : input.cadenceUnit,
  });
  const priority = input.priority ?? existing?.priority ?? DEFAULT_PODCAST_SHOW_PRIORITY;

  if (priority !== "NORMAL" && priority !== "PRIORITY") {
    throw new Error("Podcast show priority must be NORMAL or PRIORITY.");
  }

  return {
    spotifyShowId: normalizedShowId,
    showName:
      input.showName === undefined
        ? existing?.showName ?? null
        : normalizedOptionalText(input.showName),
    ...cadence,
    priority,
  };
}

export async function loadPodcastShowCadencePolicies(
  userId: string,
): Promise<Map<string, PodcastShowCadencePolicySnapshot>> {
  const rows = await prisma.podcastShowCadencePolicy.findMany({
    where: { userId },
    select: {
      spotifyShowId: true,
      showName: true,
      cadenceMaxEpisodes: true,
      cadenceUnit: true,
      priority: true,
    },
  });

  return new Map(
    rows.map((row) => {
      const snapshot: PodcastShowCadencePolicySnapshot = {
        spotifyShowId: row.spotifyShowId,
        showName: normalizedOptionalText(row.showName),
        ...normalizePodcastShowCadence({
          cadenceMaxEpisodes: row.cadenceMaxEpisodes,
          cadenceUnit: row.cadenceUnit,
        }),
        priority: row.priority,
      };
      return [snapshot.spotifyShowId, snapshot] as const;
    }),
  );
}

export async function savePodcastShowCadencePolicy(
  userId: string,
  spotifyShowId: string,
  input: PodcastShowCadencePolicyUpdate,
): Promise<PodcastShowCadencePolicySnapshot> {
  const normalizedShowId = normalizedRequiredId(spotifyShowId, "spotifyShowId");
  const existingRow = await prisma.podcastShowCadencePolicy.findUnique({
    where: {
      userId_spotifyShowId: {
        userId,
        spotifyShowId: normalizedShowId,
      },
    },
    select: {
      spotifyShowId: true,
      showName: true,
      cadenceMaxEpisodes: true,
      cadenceUnit: true,
      priority: true,
    },
  });
  const existing: PodcastShowCadencePolicySnapshot | null = existingRow
    ? {
        spotifyShowId: existingRow.spotifyShowId,
        showName: normalizedOptionalText(existingRow.showName),
        ...normalizePodcastShowCadence({
          cadenceMaxEpisodes: existingRow.cadenceMaxEpisodes,
          cadenceUnit: existingRow.cadenceUnit,
        }),
        priority: existingRow.priority,
      }
    : null;
  const resolved = resolvePodcastShowCadencePolicyUpdate(
    normalizedShowId,
    existing,
    input,
  );

  await prisma.podcastShowCadencePolicy.upsert({
    where: {
      userId_spotifyShowId: {
        userId,
        spotifyShowId: normalizedShowId,
      },
    },
    create: {
      userId,
      spotifyShowId: normalizedShowId,
      showName: resolved.showName,
      cadenceMaxEpisodes: resolved.cadenceMaxEpisodes,
      cadenceUnit: resolved.cadenceUnit,
      priority: resolved.priority,
    },
    update: {
      showName: resolved.showName,
      cadenceMaxEpisodes: resolved.cadenceMaxEpisodes,
      cadenceUnit: resolved.cadenceUnit,
      priority: resolved.priority,
    },
  });

  return resolved;
}

function normalizedRequiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizedOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
