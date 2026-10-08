import { randomUUID } from "node:crypto";

import type {
  Prisma,
  TargetPlaylist,
  TargetScheduleRun,
  TargetScheduleRunStatus,
} from "@prisma/client";

import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { assessCalendar03GenerationConfiguration } from "@/services/calendar-event-composition-generation";
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
import {
  LEGACY_GLOBAL_SHARING_POLICY,
  resolveEffectiveSharingPolicy,
} from "@/services/playlist-planner/target-sharing-shadow";
import type {
  TargetSharingReservationOwner,
} from "@/services/playlist-planner/target-sharing-runtime";
import {
  calendar03PlannerRuntimeSummary,
  createCalendar03PlannerRuntimeState,
  runWithCalendar03PlannerRuntimeState,
} from "@/services/playlist-planner/calendar-event-composition-runtime";
import { SpotifyClient } from "@/services/spotify";
import { getActiveSpotifyBackoff } from "@/services/spotify/backoff";
import {
  dailyScheduleSlot,
  isValidTimeZone,
} from "@/services/target-schedule";

import { generatePlaylists } from "./generate-playlists";
import { runIsolated } from "./isolated-execution";
import { podcast09DestinationEpisodeIds } from "./podcast09-destination-evidence";

const RETRY_AFTER_MS = 30 * 60 * 1000;
const MAX_SCHEDULE_ATTEMPTS = 3;

const TERMINAL_SCHEDULE_STATUSES =
  new Set<TargetScheduleRunStatus>([
    "SUCCESS",
    "NOOP",
    "PARTIAL",
    "BLOCKED",
  ]);

const STALE_RUNNING_ATTEMPT_REASON =
  "Tentativa expirada após 30 minutos sem conclusão; um novo retry assumiu o slot.";
const PROCESS_RESTARTED_ATTEMPT_REASON =
  "Tentativa abandonada após reinício do processo; um novo retry assumiu o slot.";

// #435 Gate 3E: PM2 runs a single scheduler instance. The logical PM2
// instance id survives a process restart while this owner id does not, letting
// the next process distinguish a dead predecessor from another live instance.
const SCHEDULER_INSTANCE_ID =
  process.env.NODE_APP_INSTANCE?.trim() || "standalone";
const SCHEDULER_OWNER_ID =
  `${SCHEDULER_INSTANCE_ID}:${process.pid}:${randomUUID()}`;

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
      select: {
        id: true,
        email: true,
        defaultTargetSharingPolicy: true,
      },
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
      const baseAssessment = await assessConfiguration(user.id);
      const calendar03Configuration = await assessCalendar03GenerationConfiguration(
        user.id,
        baseAssessment,
      );
      const assessment = calendar03Configuration.assessment;
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
      const currentDestinationEpisodeIdsByTargetId: Record<string, string[]> = {};
      let maintenanceSpotify: SpotifyClient | null = null;

      for (const entry of claimed) {
        scheduledPolicyByTargetId[entry.target.id] = entry.target.updatePolicy as
          | "KEEP_FILLED"
          | "REBUILD_DAILY";
        if (entry.target.updatePolicy !== "KEEP_FILLED") {
          try {
            await recordAttemptCheckpoint(entry.audit, "REBUILD_PREP_START");
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
            currentDestinationEpisodeIdsByTargetId[entry.target.id] =
              podcast09DestinationEpisodeIds(before.items);
            await recordAttemptCheckpoint(entry.audit, "REBUILD_PREP_DONE");
            executable.push(entry);
          } catch (error) {
            const reason = errorMessage(error);
            await finishOne(entry.audit, "BLOCKED", reason, now);
            results.push(result(entry, "", `blocked: ${reason}`));
          }
          continue;
        }
        try {
          await recordAttemptCheckpoint(entry.audit, "KEEP_FILLED_PREP_START");
          const prepared = await prepareKeepFilledTarget(user.id, entry.target, now);
          await recordAttemptCheckpoint(entry.audit, "KEEP_FILLED_PREP_DONE");
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

          const spotifyBackoff =
            await getActiveSpotifyBackoff();

          if (spotifyBackoff) {
            const reason =
              `Spotify ${spotifyBackoff.reason} ativo até ${spotifyBackoff.blockedUntil.toISOString()}; ` +
              "execução agendada interrompida localmente sem novas chamadas ao provedor.";

            await finishOne(
              entry.audit,
              "BLOCKED",
              reason,
              new Date(),
            );

            results.push(
              result(
                entry,
                "",
                `blocked: ${reason}`,
              ),
            );

            return;
          }

          const outsideTargets = await prisma.targetPlaylist.findMany({
            where: {
              userId: user.id,
              enabled: true,
              id: { notIn: [targetId] },
              spotifyPlaylistId: { not: null },
            },
            orderBy: { priority: "asc" },
            select: {
              id: true,
              spotifyPlaylistId: true,
              sharingPolicy: true,
            },
          });

          const externalReservationsByUri: Record<
            string,
            TargetSharingReservationOwner[]
          > = {};
          const reservedTargetSnapshots: Record<string, string> = {};
          if (outsideTargets.length > 0) {
            maintenanceSpotify ??= await SpotifyClient.forUser(user.id);
            for (const outside of outsideTargets) {
              if (!outside.spotifyPlaylistId) continue;
              const state = await maintenanceSpotify.getTargetPlaylistState(
                outside.spotifyPlaylistId,
              );
              reservedTargetSnapshots[outside.spotifyPlaylistId] = state.snapshotId;

              const outsideSharingPolicy = resolveEffectiveSharingPolicy(
                outside.sharingPolicy,
                user.defaultTargetSharingPolicy ??
                  LEGACY_GLOBAL_SHARING_POLICY,
              );

              for (const item of state.items) {
                if (!item.uri) continue;

                const owners = externalReservationsByUri[item.uri] ?? [];
                owners.push({
                  targetPlaylistId: outside.id,
                  sharingPolicy: outsideSharingPolicy,
                });
                externalReservationsByUri[item.uri] = owners;
              }
            }
          }

          const musicOrderSimulationEvidence =
            entry.target.updatePolicy === "REBUILD_DAILY" && reusable?.[targetId]
              ? { [targetId]: reusable[targetId] }
              : {};
          const calendar03State = createCalendar03PlannerRuntimeState({
            policies: calendar03Configuration.policies,
            requestedMode: process.env.CALENDAR_03_PLANNER_MODE ?? "SHADOW",
            userEmail: user.email ?? null,
            activeEmailAllowlist:
              process.env.CALENDAR_03_PLANNER_EMAIL_ALLOWLIST ?? null,
            activeTargetIds: process.env.CALENDAR_03_PLANNER_TARGET_IDS ?? null,
          });
          const generated = await runWithCalendar03PlannerRuntimeState(
            calendar03State,
            () =>
              generatePlaylists({
                userId: user.id,
                trigger: "SCHEDULED",
                targetPlaylistIds: [targetId],
                onGenerationRunCreated: (generationRunId) =>
                  linkGenerationRun(entry.audit, generationRunId),
                assertGenerationRunStillActive: (generationRunId) =>
                  assertAttemptOwnsGenerationRun(entry.audit, generationRunId),
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
                externalReservationsByUri,
                reservedTargetSnapshots,
                rebuildByTargetId: rebuildByTargetId[targetId]
                  ? { [targetId]: rebuildByTargetId[targetId] }
                  : {},
                ...(currentDestinationEpisodeIdsByTargetId[targetId] !== undefined
                  ? {
                      currentDestinationEpisodeIdsByTargetId: {
                        [targetId]: currentDestinationEpisodeIdsByTargetId[targetId]!,
                      },
                    }
                  : {}),
              }),
          );

          const generation = await prisma.generationRun.findUnique({
            where: { id: generated.runId },
            select: { status: true, error: true, summary: true },
          });
          const existingSummary =
            generation?.summary &&
            typeof generation.summary === "object" &&
            !Array.isArray(generation.summary)
              ? (generation.summary as Record<string, unknown>)
              : {};
          await prisma.generationRun.updateMany({
            where: {
              id: generated.runId,
              userId: user.id,
              simulation: false,
            },
            data: {
              summary: {
                ...existingSummary,
                configurationFingerprint: assessment.fingerprint,
                calendar03PlannerRuntime:
                  calendar03PlannerRuntimeSummary(calendar03State),
              } as Prisma.InputJsonValue,
            },
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
    if (
      TERMINAL_SCHEDULE_STATUSES.has(
        existing.status,
      )
    ) {
      return null;
    }

    const currentAttempt =
      existing.status === "RUNNING"
        ? await readCurrentAttemptForRecovery(existing)
        : null;

    if (
      currentAttempt?.generationRun &&
      currentAttempt.generationRun.trigger === "SCHEDULED" &&
      currentAttempt.generationRun.simulation === false &&
      currentAttempt.generationRun.status !== "RUNNING"
    ) {
      await reconcileCompletedScheduledAttempt(
        existing,
        currentAttempt.generationRun,
        now,
      );
      return null;
    }

    if (
      existing.attempt >=
      MAX_SCHEDULE_ATTEMPTS
    ) {
      return null;
    }

    const processRestartTakeover =
      existing.status === "RUNNING" &&
      attemptOwnedByPreviousProcess(currentAttempt?.details);

    if (
      !processRestartTakeover &&
      now.getTime() -
        existing.startedAt.getTime() <
        RETRY_AFTER_MS
    ) {
      return null;
    }

    const retryReason = processRestartTakeover
      ? PROCESS_RESTARTED_ATTEMPT_REASON
      : STALE_RUNNING_ATTEMPT_REASON;
    const terminalCheckpoint = processRestartTakeover
      ? "PROCESS_RESTART_TERMINALIZED"
      : "STALE_TERMINALIZED";

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
        const staleAttempt = await tx.targetScheduleAttempt.findUnique({
          where: {
            targetScheduleRunId_attempt: {
              targetScheduleRunId: existing.id,
              attempt: existing.attempt,
            },
          },
          select: { generationRunId: true },
        });

        const stale = await tx.targetScheduleAttempt.updateMany({
          where: {
            targetScheduleRunId: existing.id,
            attempt: existing.attempt,
            status: "RUNNING",
          },
          data: {
            status: "FAILED",
            reason: retryReason,
            finishedAt: now,
          },
        });
        if (stale.count !== 1) {
          throw new Error(
            `Missing TargetScheduleAttempt ${existing.id}#${existing.attempt} while expiring stale retry`,
          );
        }

        if (staleAttempt?.generationRunId) {
          const terminalizedRun = await tx.generationRun.updateMany({
            where: {
              id: staleAttempt.generationRunId,
              status: "RUNNING",
            },
            data: {
              status: "FAILED",
              finishedAt: now,
              error: retryReason,
            },
          });

          if (terminalizedRun.count === 1) {
            await tx.generationLog.create({
              data: {
                runId: staleAttempt.generationRunId,
                level: "ERROR",
                message: `Checkpoint ${terminalCheckpoint}`,
                data: {
                  checkpoint: terminalCheckpoint,
                  targetScheduleRunId: existing.id,
                  attempt: existing.attempt,
                },
              },
            });
          }
        }
      }

      await tx.targetScheduleAttempt.create({
        data: {
          targetScheduleRunId: existing.id,
          attempt: existing.attempt + 1,
          status: "RUNNING",
          startedAt: now,
          details: runningAttemptDetails("CLAIMED"),
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
        details: runningAttemptDetails("CLAIMED"),
      },
    });

    return audit;
  });
}

type CurrentAttemptForRecovery = {
  details: Prisma.JsonValue | null;
  generationRun: {
    id: string;
    trigger: string;
    simulation: boolean;
    status: string;
    error: string | null;
    summary: Prisma.JsonValue | null;
    finishedAt: Date | null;
  } | null;
};

function runningAttemptDetails(
  checkpoint: string,
  extra: Record<string, string | number | boolean | null> = {},
): Prisma.InputJsonValue {
  return {
    schedulerOwnerId: SCHEDULER_OWNER_ID,
    schedulerInstanceId: SCHEDULER_INSTANCE_ID,
    checkpoint,
    observedAt: new Date().toISOString(),
    ...extra,
  };
}

function attemptOwnedByPreviousProcess(details: unknown): boolean {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return false;
  }
  const record = details as Record<string, unknown>;
  return (
    typeof record.schedulerOwnerId === "string" &&
    typeof record.schedulerInstanceId === "string" &&
    record.schedulerInstanceId === SCHEDULER_INSTANCE_ID &&
    record.schedulerOwnerId !== SCHEDULER_OWNER_ID
  );
}

async function readCurrentAttemptForRecovery(
  existing: TargetScheduleRun,
): Promise<CurrentAttemptForRecovery | null> {
  return prisma.targetScheduleAttempt.findUnique({
    where: {
      targetScheduleRunId_attempt: {
        targetScheduleRunId: existing.id,
        attempt: existing.attempt,
      },
    },
    select: {
      details: true,
      generationRun: {
        select: {
          id: true,
          trigger: true,
          simulation: true,
          status: true,
          error: true,
          summary: true,
          finishedAt: true,
        },
      },
    },
  });
}

async function reconcileCompletedScheduledAttempt(
  existing: TargetScheduleRun,
  generation: NonNullable<CurrentAttemptForRecovery["generationRun"]>,
  now: Date,
): Promise<void> {
  const targetSummary =
    readTargetSummaries(generation.summary).get(existing.targetPlaylistId) ?? null;
  const status = scheduleStatus(generation.status, targetSummary);
  const reason =
    typeof targetSummary?.error === "string"
      ? targetSummary.error
      : generation.error ?? null;

  await finishOne(
    { id: existing.id, attempt: existing.attempt },
    status,
    reason,
    generation.finishedAt ?? now,
    {
      generationRunId: generation.id,
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
    },
  );
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

async function recordAttemptCheckpoint(
  audit: ScheduleAttemptRef,
  checkpoint:
    | "KEEP_FILLED_PREP_START"
    | "KEEP_FILLED_PREP_DONE"
    | "REBUILD_PREP_START"
    | "REBUILD_PREP_DONE",
): Promise<void> {
  const updated = await prisma.targetScheduleAttempt.updateMany({
    where: {
      targetScheduleRunId: audit.id,
      attempt: audit.attempt,
      status: "RUNNING",
    },
    data: {
      details: runningAttemptDetails(checkpoint),
    },
  });

  if (updated.count !== 1) {
    throw new Error(
      `Scheduled attempt ${audit.id}#${audit.attempt} is no longer RUNNING while entering ${checkpoint}`,
    );
  }
}

async function linkGenerationRun(audit: ScheduleAttemptRef, generationRunId: string) {
  await prisma.$transaction(async (tx) => {
    const generation = await tx.generationRun.findUnique({
      where: { id: generationRunId },
      select: { trigger: true, simulation: true },
    });
    if (
      !generation ||
      generation.trigger !== "SCHEDULED" ||
      generation.simulation
    ) {
      throw new Error(
        `GenerationRun ${generationRunId} is not a real SCHEDULED run and cannot own scheduler attempt ${audit.id}#${audit.attempt}`,
      );
    }

    const attempt = await tx.targetScheduleAttempt.updateMany({
      where: {
        targetScheduleRunId: audit.id,
        attempt: audit.attempt,
        status: "RUNNING",
      },
      data: {
        generationRunId,
        details: runningAttemptDetails("GENERATION_LINKED", {
          generationRunId,
        }),
      },
    });
    if (attempt.count !== 1) {
      throw new Error(
        `Missing RUNNING TargetScheduleAttempt ${audit.id}#${audit.attempt} while linking generation`,
      );
    }

    // Only the attempt that still owns the aggregate may update its summary.
    // A late/stale attempt keeps its own GenerationRun link above, but cannot
    // overwrite a newer retry's aggregate state.
    await tx.targetScheduleRun.updateMany({
      where: {
        id: audit.id,
        status: "RUNNING",
        attempt: audit.attempt,
      },
      data: { generationRunId },
    });
  });
}

async function assertAttemptOwnsGenerationRun(
  audit: ScheduleAttemptRef,
  generationRunId: string,
): Promise<void> {
  const [aggregate, attempt, generationRun] = await prisma.$transaction([
    prisma.targetScheduleRun.findUnique({
      where: { id: audit.id },
      select: { status: true, attempt: true, generationRunId: true },
    }),
    prisma.targetScheduleAttempt.findUnique({
      where: {
        targetScheduleRunId_attempt: {
          targetScheduleRunId: audit.id,
          attempt: audit.attempt,
        },
      },
      select: { status: true, generationRunId: true },
    }),
    prisma.generationRun.findUnique({
      where: { id: generationRunId },
      select: { status: true },
    }),
  ]);

  const ownsAggregate =
    aggregate?.status === "RUNNING" &&
    aggregate.attempt === audit.attempt &&
    aggregate.generationRunId === generationRunId;
  const ownsAttempt =
    attempt?.status === "RUNNING" &&
    attempt.generationRunId === generationRunId;
  const runIsActive = generationRun?.status === "RUNNING";

  if (ownsAggregate && ownsAttempt && runIsActive) return;

  throw new Error(
    `GenerationRun ${generationRunId} lost ownership of scheduled attempt ${audit.id}#${audit.attempt}; provider write fenced`,
  );
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