import { prisma } from "@/lib/prisma";
import { LastFmClient } from "@/services/lastfm/client";
import { readLastFmRecentObservation } from "@/services/music-preference/lastfm-coverage-reader";

import {
  buildMusicExposureShadow,
  MUSIC_07_SHADOW_THRESHOLD_DEFAULT,
  type MusicExposureShadowPublication,
  type MusicExposureShadowReport,
  type MusicExposureShadowScrobble,
  type MusicExposureShadowUpdatePolicy,
} from "./shadow";

export type MusicExposureReadModelInput = {
  userId: string;
  to: Date;
  from?: Date | null;
  threshold?: number;
  maxPages?: number;
  targetPlaylistIds?: readonly string[] | null;
};

export type MusicExposureReadModel = {
  user: { id: string; email: string | null };
  report: MusicExposureShadowReport;
  scrobbles: readonly MusicExposureShadowScrobble[];
  policy: {
    enabled: boolean;
    windowValue: number | null;
    windowUnit: "DAYS" | "MONTHS" | "YEARS" | null;
  } | null;
  diagnostics: {
    transactionReadOnly: string;
    realRunCount: number;
    identityReadyItemCount: number;
    measurableTargetSnapshotCount: number;
    appliedTargetPublicationCount: number;
    keepFilledNoopBaselineCount: number;
    missingApplyProofCount: number;
    lastFmStatus:
      | "NOT_QUERIED_NO_PUBLICATIONS"
      | "UNAVAILABLE_MISSING_ENV"
      | "COMPLETE"
      | "PARTIAL_BOUNDED";
    lastFmPagesFetched: number;
    lastFmTotalPages: number;
    lastFmComplete: boolean;
    lastFmScrobbleCount: number;
  };
};

/**
 * MUSIC-07 canonical read model.
 *
 * GenerationRun + GenerationItem + summary.targets[].applied are the canonical
 * Sonoriza-owned exposure ledger. Gate 3 intentionally does not create a second
 * TrackExposure table and therefore avoids two competing truths.
 *
 * Database reads are performed inside an explicit PostgreSQL READ ONLY snapshot.
 * Last.fm is read afterwards and is used only as independent consumption
 * evidence. Spotify playback/history APIs are never called here.
 */
export async function readMusicExposureModel(
  input: MusicExposureReadModelInput,
): Promise<MusicExposureReadModel> {
  assertDate(input.to, "to");
  if (input.from) {
    assertDate(input.from, "from");
    if (input.from >= input.to) throw new Error("MUSIC-07 requires from < to");
  }

  const targetPlaylistIds = input.targetPlaylistIds
    ? [...new Set(input.targetPlaylistIds.filter(Boolean))]
    : null;
  const threshold = input.threshold ?? MUSIC_07_SHADOW_THRESHOLD_DEFAULT;
  const maxPages = input.maxPages ?? 10;

  const snapshot = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const readOnly = await tx.$queryRaw<Array<{ read_only: string }>>`
        SELECT current_setting('transaction_read_only') AS read_only
      `;
      if (readOnly[0]?.read_only !== "on") {
        throw new Error("MUSIC-07 refused to run without READ ONLY transaction");
      }

      const user = await tx.user.findUnique({
        where: { id: input.userId },
        select: { id: true, email: true },
      });
      if (!user) throw new Error(`Sonoriza user not found: ${input.userId}`);

      const policy = await tx.musicPlaybackPolicy.findUnique({
        where: { userId: input.userId },
        select: { enabled: true, windowValue: true, windowUnit: true },
      });

      const runs = await tx.generationRun.findMany({
        where: {
          userId: input.userId,
          simulation: false,
          status: { in: ["SUCCESS", "PARTIAL"] },
          startedAt: {
            ...(input.from ? { gte: input.from } : {}),
            lte: input.to,
          },
        },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          status: true,
          simulation: true,
          startedAt: true,
          finishedAt: true,
          summary: true,
          items: {
            where: {
              contentType: "MUSIC",
              spotifyTrackId: { not: null },
              title: { not: null },
              subtitle: { not: null },
              ...(targetPlaylistIds
                ? { targetPlaylistId: { in: targetPlaylistIds } }
                : {}),
            },
            orderBy: [{ targetPlaylistId: "asc" }, { position: "asc" }],
            select: {
              targetPlaylistId: true,
              position: true,
              spotifyTrackId: true,
              title: true,
              subtitle: true,
              target: {
                select: {
                  name: true,
                  updatePolicy: true,
                },
              },
            },
          },
        },
      });

      return {
        user,
        policy,
        runs,
        transactionReadOnly: readOnly[0]?.read_only ?? "unknown",
      };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  const publications: MusicExposureShadowPublication[] = [];
  let missingApplyProofCount = 0;
  let identityReadyItemCount = 0;
  let keepFilledNoopBaselineCount = 0;

  for (const run of snapshot.runs) {
    const byTarget = new Map<string, typeof run.items>();
    for (const item of run.items) {
      const current = byTarget.get(item.targetPlaylistId);
      if (current) current.push(item);
      else byTarget.set(item.targetPlaylistId, [item]);
    }

    for (const [targetPlaylistId, items] of byTarget) {
      identityReadyItemCount += items.length;
      const first = items[0]!;
      const updatePolicy = first.target.updatePolicy as MusicExposureShadowUpdatePolicy;
      const applied = targetAppliedFromSummary(run.summary, targetPlaylistId);
      if (applied === null) {
        missingApplyProofCount += 1;
        continue;
      }
      if (!applied && updatePolicy !== "KEEP_FILLED") continue;
      if (!applied && updatePolicy === "KEEP_FILLED") {
        keepFilledNoopBaselineCount += 1;
      }

      const publishedAt = run.finishedAt ?? run.startedAt;
      if (publishedAt > input.to) continue;

      publications.push({
        runId: run.id,
        targetPlaylistId,
        targetName: first.target.name,
        updatePolicy,
        publishedAt,
        simulation: run.simulation,
        status: run.status,
        applied,
        tracks: items.flatMap((item) => {
          const trackId = item.spotifyTrackId?.trim();
          const trackName = item.title?.trim();
          const artistName = item.subtitle?.trim();
          if (!trackId || !trackName || !artistName) return [];
          return [
            {
              trackKey: `spotify:${trackId}`,
              trackName,
              artistName,
              position: item.position,
            },
          ];
        }),
      });
    }
  }

  const earliestPublication = publications.reduce<Date | null>(
    (earliest, row) =>
      earliest === null || row.publishedAt < earliest ? row.publishedAt : earliest,
    null,
  );

  let scrobbles: MusicExposureShadowScrobble[] = [];
  let lastFmStatus: MusicExposureReadModel["diagnostics"]["lastFmStatus"] =
    "NOT_QUERIED_NO_PUBLICATIONS";
  let lastFmPagesFetched = 0;
  let lastFmTotalPages = 0;
  let lastFmComplete = false;

  if (earliestPublication) {
    const apiKey = process.env.LASTFM_API_KEY?.trim();
    const username = process.env.LASTFM_USERNAME?.trim();
    if (!apiKey || !username) {
      lastFmStatus = "UNAVAILABLE_MISSING_ENV";
    } else {
      const observation = await readLastFmRecentObservation({
        client: new LastFmClient({ apiKey }),
        username,
        from: new Date(Math.max(0, earliestPublication.getTime() - 60_000)),
        to: input.to,
        maxPages,
      });
      scrobbles = observation.scrobbles.map((row) => ({
        playedAt: row.playedAt,
        trackName: row.trackName,
        artistName: row.artistName,
      }));
      lastFmPagesFetched = observation.pagesFetched;
      lastFmTotalPages = observation.totalPages;
      lastFmComplete = observation.complete;
      lastFmStatus = observation.complete ? "COMPLETE" : "PARTIAL_BOUNDED";
    }
  }

  const report = buildMusicExposureShadow({
    publications,
    scrobbles,
    observedUntil: input.to,
    threshold,
  });

  return {
    user: snapshot.user,
    report,
    scrobbles,
    policy: snapshot.policy,
    diagnostics: {
      transactionReadOnly: snapshot.transactionReadOnly,
      realRunCount: snapshot.runs.length,
      identityReadyItemCount,
      measurableTargetSnapshotCount: publications.length,
      appliedTargetPublicationCount: publications.filter((row) => row.applied).length,
      keepFilledNoopBaselineCount,
      missingApplyProofCount,
      lastFmStatus,
      lastFmPagesFetched,
      lastFmTotalPages,
      lastFmComplete,
      lastFmScrobbleCount: scrobbles.length,
    },
  };
}

export function targetAppliedFromSummary(
  summary: unknown,
  targetPlaylistId: string,
): boolean | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return null;
  for (const raw of targets) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.targetPlaylistId !== targetPlaylistId) continue;
    return typeof row.applied === "boolean" ? row.applied : null;
  }
  return null;
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`MUSIC-07 requires valid ${label}`);
  }
}
