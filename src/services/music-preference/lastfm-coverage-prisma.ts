import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "@/lib/prisma";

import type { PublishedMusicOccurrence } from "./lastfm-coverage";

export type PublishedMusicTarget = Readonly<{
  targetPlaylistId: string;
  occurrences: readonly PublishedMusicOccurrence[];
}>;

export type PublishedMusicRun = Readonly<{
  generationRunId: string;
  publishedAt: Date;
  startedAt: Date;
  finishedAt: Date | null;
  targets: readonly PublishedMusicTarget[];
}>;

/**
 * Loads the exact music order that Sonoriza persisted for a real applied run.
 * The order is first-party execution evidence; no provider read is performed.
 */
export async function loadPublishedMusicRun(
  userId: string,
  generationRunId: string,
  client: PrismaClient = defaultPrisma,
): Promise<PublishedMusicRun> {
  const normalizedUserId = userId.trim();
  const normalizedRunId = generationRunId.trim();
  if (!normalizedUserId) throw new Error("MUSIC-06 published run requires userId");
  if (!normalizedRunId) {
    throw new Error("MUSIC-06 published run requires generationRunId");
  }

  const run = await client.generationRun.findFirst({
    where: {
      id: normalizedRunId,
      userId: normalizedUserId,
      simulation: false,
      status: { in: ["SUCCESS", "PARTIAL"] },
    },
    select: {
      id: true,
      startedAt: true,
      finishedAt: true,
      items: {
        where: { contentType: "MUSIC" },
        orderBy: { position: "asc" },
        select: {
          id: true,
          targetPlaylistId: true,
          position: true,
          title: true,
          subtitle: true,
          spotifyTrackId: true,
        },
      },
    },
  });

  if (!run) {
    throw new Error(
      `MUSIC-06 published real generation not found: ${normalizedRunId}`,
    );
  }

  const publishedAt = run.finishedAt ?? run.startedAt;
  const byTarget = new Map<string, PublishedMusicOccurrence[]>();

  for (const item of run.items) {
    const occurrence: PublishedMusicOccurrence = {
      generationRunId: run.id,
      targetPlaylistId: item.targetPlaylistId,
      generationItemId: item.id,
      position: item.position,
      publishedAt,
      trackName: clean(item.title),
      artistName: clean(item.subtitle),
      spotifyTrackId: clean(item.spotifyTrackId),
    };
    const rows = byTarget.get(item.targetPlaylistId);
    if (rows) rows.push(occurrence);
    else byTarget.set(item.targetPlaylistId, [occurrence]);
  }

  return {
    generationRunId: run.id,
    publishedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    targets: [...byTarget.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([targetPlaylistId, occurrences]) => ({
        targetPlaylistId,
        occurrences: occurrences.sort(
          (left, right) => left.position - right.position,
        ),
      })),
  };
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
