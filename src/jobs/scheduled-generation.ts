import type {
  Prisma,
  TargetPlaylist,
  TargetScheduleRun,
  TargetScheduleRunStatus,
} from "@prisma/client";

import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { dispatchTargetScheduleRunNotificationSafely } from "@/services/notifications";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import {
  prepareKeepFilledTarget,
  type KeepFilledTargetPatch,
} from "@/services/keep-filled-maintenance";
import { findReusableSimulationMusicOrderEvidence } from "@/services/music-order-simulation";
import type { Candidate } from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";
import {
  dailyScheduleSlot,
  isValidTimeZone,
} from "@/services/target-schedule";

import { generatePlaylists } from "./generate-playlists";
import { runIsolated } from "./isolated-execution";

const RETRY_AFTER_MS = 30 * 60 * 1000;
const STALE_RUNNING_ATTEMPT_REASON =
  "Tentativa expirada após 30 minutos sem conclusão; um novo retry assumiu o slot.";

type ScheduledResult = {
  userId: string;
  targetPlaylistId: string;
  scheduleRunId: string;
  runId: string;
  status: string;
};

type ScheduleAttemptRef = Pick<TargetScheduleRun, "id" | "attempt">;

export async function runScheduledGeneration(
  now = new Date(),
): Promise<{ processed: number; results: ScheduledResult[] }> {
  const users = (
    await prisma.user.findMany({
      where: {
        targetPlaylists: {
          some: { enabled: true, updatePolicy: { not: "MANUAL" } },
        },
      },
      select: { id: true, email: true },
    })
  ).filter((user) => isEmailAllowed(user.email));

  const results: ScheduledResult[] = [];
  let processed = 0;

  for (const user of users) {
    const targets = await prisma.targetPlaylist.findMany({
      where: {
        userId: user.id,
        enabled: true,
        updatePolicy: { not: "MANUAL" },
      },
      orderBy: { priority: "asc" },
    });

    const claimed: Array<{ target: TargetPlaylist; audit: TargetScheduleRun }> = [];
    for (const target of targets) {
      const minutes = target.dailyScheduleMinutes;
      const timeZone = target.scheduleTimezone?.trim() ?? "";
      if (
        minutes === null ||
        !Number.isInteger(minutes) ||
        minutes < 0 ||
        minutes > 1439 ||
        !isValidTimeZone(timeZone)
      ) {
        continue;
      }
      const slot = dailyScheduleSlot(target.id, minutes, timeZone, now);
      if (!slot.due) continue;

      const audit = await claimScheduleSlot(user.id, target, slot, now);
      if (!audit) continue;
      claimed.push({ target, audit });
      processed += 1;
    }

    if (claimed.length === 0) continue;

    try {
      const assessment = await assessConfiguration(user.id);
      const gate = await getFirstRunGate(user.id, assessment);
      if (!gate.realRunAllowed) {
        await finishMany(
          claimed.map((entry) => entry.audit),
          "BLOCKED",
          gate.reason ?? "simulação atual não aprovada",
          now,
        );
        for (const entry of claimed) {
          results.push(result(entry, "", `blocked: ${gate.reason ?? "simulation gate"}`));
        }
        continue;
      }

      const executable: typeof claimed = [];
      const preservedByTargetId: Record<string, Candidate[]> = {};
      const keepFilledByTargetId: Record<string, KeepFilledTargetPatch> = {};
      const scheduledPolicyByTargetId: Record<
        string,
        "KEEP_FILLED" | "REBUILD_DAILY"
      > = {};
      const rebuildByTargetId: Record<
        string,
        { snapshotBefore: string; currentCount: number; currentDurationMs: number }
      > = {};
      let maintenanceSpotify: SpotifyClient | null = null;

      for (const entry of claimed) {
        scheduledPolicyByTargetId[entry.target.id] = entry.target.updatePolicy as
          | "KEEP_FILLED"
          | "REBUILD_DAILY";
        if (entry.target.updatePolicy !== "KEEP_FILLED") {
          try {
            if (!entry.target.spotifyPlaylistId) {
              throw new Error(`Target "${entry.target.name}" has no Spotify playlist`);
            }
            maintenanceSpotify ??= await SpotifyClient.forUser(user.id);
            const before = await maintenanceSpotify.getTargetPlaylistState(
              entry.target.spotifyPlaylistId,
            );
            rebuildByTargetId[entry.target.id] = {
              snapshotBefore: before.snapshotId,
              currentCount: before.items.length,
              currentDurationMs: before.items.reduce(
                (sum, item) => sum + Math.max(0, item.originalDurationMs ?? 0),
                0,
              ),
            };
            executable.push(entry);
          } catch (error) {
            const reason = errorMessage(error);
            await finishOne(entry.audit, "BLOCKED", reason, now);
            results.push(result(entry, "", `blocked: ${reason}`));
          }
          continue;
        }
        try {
          const prepared = await prepareKeepFilledTarget(user.id, entry.target, now);
          if (prepared.skipReason) {
            await finishOne(entry.audit, "NOOP", prepared.skipReason, now, {
              targetDurationMs: 0,
            });
            results.push(result(entry, "", `noop: ${prepared.skipReason}`));
            continue;
          }
          preservedByTargetId[entry.target.id] = prepared.preserved;
          keepFilledByTargetId[entry.target.id] = prepared.patch;
          executable.push(entry);
        } catch (error) {
          const reason = errorMessage(error);
          await finishOne(entry.audit, "BLOCKED", reason, now);
          results.push(result(entry, "", `blocked: ${reason}`));
        }
      }

      if (executable.length === 0) continue;

      const reusable = await findReusableSimulationMusicOrderEvidence(
        user.id,
        assessment.fingerprint,
      );

      // SCHEDULE-02: every claimed target gets its own GenerationRun.
      // A retry can coincide with another target's slot without allowing one
      // target's deterministic failure to abort the other. Exclusivity is
      // preserved by reserving every other enabled target from live Spotify
      // state immediately before each isolated run.
      await runIsolated(
        executable,
        async (entry) => {
          const targetId = entry.target.id;
          const outsideTargets = await prisma.targetPlaylist.findMany({
            where: {
              userId: user.id,
              enabled: true,
              id: { notIn: [targetId] },
              spotifyPlaylistId: { not: null },
            },
            orderBy: { priority: "asc" },
            select: { id: true, spotifyPlaylistId: true },
          });
          const reservedUris = new Set<string>();
          const reservedTargetSnapshots: Record<string, string> = {};
          if (outsideTargets.length > 0) {
            maintenanceSpotify ??= await SpotifyClient.forUser(user.id);
            for (const outside of outsideTargets) {
              if (!outside.spotifyPlaylistId) continue;
              const state = await maintenanceSpotify.getTargetPlaylistState(
                outside.spotifyPlaylistId,
              );
              reservedTargetSnapshots[outside.spotifyPlaylistId] = state.snapshotId;
              for (const item of state.items) {
                if (item.uri) reservedUris.add(item.uri);
              }
            }
          }

          const musicOrderSimulationEvidence =
            entry.target.updatePolicy === "REBUILD_DAILY" && reusable?.[targetId]
              ? { [targetId]: reusable[targetId] }
              : {};
          const generated = await generatePlaylists({
            userId: user.id,
            trigger: "SCHEDULED",
            targetPlaylistIds: [targetId],
            preservedByTargetId: preservedByTargetId[targetId]
              ? { [targetId]: preservedByTargetId[targetId] }
              : {},
            keepFilledByTargetId: keepFilledByTargetId[targetId]
              ? { [targetId]: keepFilledByTargetId[targetId] }
              : {},
            scheduledPolicyByTargetId: {
              [targetId]: scheduledPolicyByTargetId[targetId]!,
            },
            musicOrderSimulationEvidence,
            reservedUris: [...reservedUris],
            reservedTargetSnapshots,
            rebuildByTargetId: rebuildByTargetId[targetId]
              ? { [targetId]: rebuildByTargetId[targetId] }
              : {},
          });

          // Persist the GenerationRun link as soon as it exists. If the process
          // dies before terminalizing the schedule attempt, the retry audit can
          // still point to the real generation that was created.
          await linkGenerationRun(entry.audit, generated.runId);

          const generation = await prisma.generationRun.findUnique({
            where: { id: generated.runId },
            select: { status: true, error: true, summary: true },
          });
          const targetSummary =
            readTargetSummaries(generation?.summary).get(targetId) ?? null;
          const status = scheduleStatus(generated.status, targetSummary);
          const reason =
            typeof targetSummary?.error === "string"
              ? targetSummary.error
              : generation?.error ?? null;

          await finishOne(entry.audit, status, reason, new Date(), {
            generationRunId: generated.runId,
            targetDurationMs: numberOrNull(targetSummary?.targetDurationMs),
            validDurationBeforeMs: numberOrNull(targetSummary?.validDurationBeforeMs),
            removedDurationMs: numberOrZero(targetSummary?.removedDurationMs),
            addedDurationMs: numberOrZero(targetSummary?.addedDurationMs),
            preservedCount: numberOrZero(targetSummary?.preservedCount),
            removedCount: numberOrZero(targetSummary?.removedCount),
            addedCount: numberOrZero(targetSummary?.addedCount),
            snapshotBefore: stringOrNull(targetSummary?.snapshotBefore),
            snapshotAfter: stringOrNull(targetSummary?.snapshotAfter),
            details: targetSummary
              ? (targetSummary as Prisma.InputJsonValue)
              : undefined,
          });
          results.push(result(entry, generated.runId, status));
        },
        async (entry, error) => {
          const reason = errorMessage(error);
          await finishOne(entry.audit, "FAILED", reason, new Date());
          results.push(result(entry, "", `error: ${reason}`));
        },
      );
    } catch (error) {
      const reason = errorMessage(error);
      await finishMany(
        claimed.map((entry) => entry.audit),
        "FAILED",
        reason,
        new Date(),
      );
      for (const entry of claimed) {
        if (results.some((item) => item.scheduleRunId === entry.audit.id)) continue;
        results.push(result(entry, "", `error: ${reason}`));
      }
    }
  }

  return { processed, results };
}

async function claimScheduleSlot(
  userId: string,
  target: TargetPlaylist,
  slot: ReturnType<typeof dailyScheduleSlot>,
  now: Date,
): Promise<TargetScheduleRun | null> {
  const existing = await prisma.targetScheduleRun.findUnique({
    where: { scheduleKey: slot.scheduleKey },
  });
  if (existing) {
    if (["SUCCESS", "NOOP", "PARTIAL"].includes(existing.status)) return null;
    if (now.getTime() - existing.startedAt.getTime() < RETRY_AFTER_MS) return null;

    return prisma.$transaction(async (tx) => {
      const claimed = await tx.targetScheduleRun.updateMany({
        where: {
          id: existing.id,
          status: existing.status,
          attempt: existing.attempt,
          startedAt: existing.startedAt,
        },
        data: {
          status: "RUNNING",
          attempt: { increment: 1 },
          generationRunId: null,
          reason: null,
          startedAt: now,
          finishedAt: null,
        },
      });
      if (claimed.count !== 1) return null;

      if (existing.status === "RUNNING") {
        await tx.targetScheduleAttempt.updateMany({
          where: {
            targetScheduleRunId: existing.id,
            attempt: existing.attempt,
            status: "RUNNING",
          },
          data: {
            status: "FAILED",
            reason: STALE_RUNNING_ATTEMPT_REASON,
            finishedAt: now,
          },
        });
      }

      await tx.targetScheduleAttempt.create({
        data: {
          targetScheduleRunId: existing.id,
          attempt: existing.attempt + 1,
          status: "RUNNING",
          startedAt: now,
        },
      });

      return tx.targetScheduleRun.findUnique({ where: { id: existing.id } });
    });
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.targetScheduleRun.createMany({
      data: [
        {
          userId,
          targetPlaylistId: target.id,
          scheduleKey: slot.scheduleKey,
          scheduledLocalDate: slot.localDate,
          scheduledForMinutes: target.dailyScheduleMinutes!,
          scheduleTimezone: target.scheduleTimezone!,
          policy: target.updatePolicy,
          status: "RUNNING",
          startedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count !== 1) return null;

    const audit = await tx.targetScheduleRun.findUnique({
      where: { scheduleKey: slot.scheduleKey },
    });
    if (!audit) {
      throw new Error(`Missing schedule run after claiming ${slot.scheduleKey}`);
    }

    await tx.targetScheduleAttempt.create({
      data: {
        targetScheduleRunId: audit.id,
        attempt: audit.attempt,
        status: "RUNNING",
        startedAt: now,
      },
    });

    return audit;
  });
}

function scheduleStatus(
  generationStatus: string,
  targetSummary: Record<string, unknown> | null,
): TargetScheduleRunStatus {
  if (generationStatus === "SUCCESS") {
    if (targetSummary?.maintenanceNoop === true) return "NOOP";
    return "SUCCESS";
  }
  if (generationStatus === "PARTIAL") return "PARTIAL";
  return "BLOCKED";
}

function readTargetSummaries(summary: unknown): Map<string, Record<string, unknown>> {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return new Map();
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return new Map();
  return new Map(
    targets.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      return typeof record.targetPlaylistId === "string"
        ? [[record.targetPlaylistId, record] as const]
        : [];
    }),
  );
}

async function finishMany(
  audits: ScheduleAttemptRef[],
  status: TargetScheduleRunStatus,
  reason: string | null,
  finishedAt: Date,
) {
  if (audits.length === 0) return;

  const completedIds = await prisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const audit of audits) {
      const aggregate = await tx.targetScheduleRun.updateMany({
        where: {
          id: audit.id,
          status: "RUNNING",
          attempt: audit.attempt,
        },
        data: { status, reason, finishedAt },
      });
      if (aggregate.count !== 1) continue;

      const attempt = await tx.targetScheduleAttempt.updateMany({
        where: {
          targetScheduleRunId: audit.id,
          attempt: audit.attempt,
          status: "RUNNING",
        },
        data: { status, reason, finishedAt },
      });
      if (attempt.count !== 1) {
        throw new Error(
          `Missing TargetScheduleAttempt ${audit.id}#${audit.attempt} while finishing`,
        );
      }
      ids.push(audit.id);
    }
    return ids;
  });

  await Promise.all(
    completedIds.map((id) => dispatchTargetScheduleRunNotificationSafely(id)),
  );
}

async function linkGenerationRun(audit: ScheduleAttemptRef, generationRunId: string) {
  await prisma.$transaction(async (tx) => {
    const aggregate = await tx.targetScheduleRun.updateMany({
      where: {
        id: audit.id,
        status: "RUNNING",
        attempt: audit.attempt,
      },
      data: { generationRunId },
    });
    if (aggregate.count !== 1) return;

    const attempt = await tx.targetScheduleAttempt.updateMany({
      where: {
        targetScheduleRunId: audit.id,
        attempt: audit.attempt,
        status: "RUNNING",
      },
      data: { generationRunId },
    });
    if (attempt.count !== 1) {
      throw new Error(
        `Missing TargetScheduleAttempt ${audit.id}#${audit.attempt} while linking generation`,
      );
    }
  });
}

async function finishOne(
  audit: ScheduleAttemptRef,
  status: TargetScheduleRunStatus,
  reason: string | null,
  finishedAt: Date,
  data: Prisma.TargetScheduleRunUncheckedUpdateInput = {},
) {
  const completed = await prisma.$transaction(async (tx) => {
    const aggregate = await tx.targetScheduleRun.updateMany({
      where: {
        id: audit.id,
        status: "RUNNING",
        attempt: audit.attempt,
      },
      data: {
        status,
        reason,
        finishedAt,
        ...data,
      },
    });
    if (aggregate.count !== 1) return false;

    const attemptData: Prisma.TargetScheduleAttemptUncheckedUpdateManyInput = {
      status,
      reason,
      finishedAt,
      ...(data.generationRunId === undefined
        ? {}
        : { generationRunId: data.generationRunId }),
      ...(data.details === undefined ? {} : { details: data.details }),
    };
    const attempt = await tx.targetScheduleAttempt.updateMany({
      where: {
        targetScheduleRunId: audit.id,
        attempt: audit.attempt,
        status: "RUNNING",
      },
      data: attemptData,
    });
    if (attempt.count !== 1) {
      throw new Error(
        `Missing TargetScheduleAttempt ${audit.id}#${audit.attempt} while finishing`,
      );
    }
    return true;
  });

  if (completed) await dispatchTargetScheduleRunNotificationSafely(audit.id);
}

function result(
  entry: { target: TargetPlaylist; audit: TargetScheduleRun },
  runId: string,
  status: string,
): ScheduledResult {
  return {
    userId: entry.target.userId,
    targetPlaylistId: entry.target.id,
    scheduleRunId: entry.audit.id,
    runId,
    status,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
