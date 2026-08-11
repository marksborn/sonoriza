from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:110]!r}")
    p.write_text(text.replace(old, new, 1))


GEN = "src/jobs/generate-playlists-incremental.ts"

replace_once(
    GEN,
    '''import {
  parseSequencePattern,
  type RunTarget,
} from "@/services/playlist-planner";''',
    '''import {
  parseSequencePattern,
  type Candidate,
  type RunTarget,
} from "@/services/playlist-planner";\nimport type { KeepFilledTargetPatch } from "@/services/keep-filled-maintenance";''',
)
replace_once(
    GEN,
    '''  applyMusicOrder,
  createMusicOrderSeed,
  type MusicOrderEvidence,''',
    '''  applyMusicOrder,
  createMusicOrderSeed,
  playlistOrderHash,
  type MusicOrderEvidence,''',
)

replace_once(
    GEN,
    '''  /** ORDER-01: one-shot seed/hash proof from a current approved simulation. */
  musicOrderSimulationEvidence?: Record<string, ReusableMusicOrderEvidence>;
}''',
    '''  /** ORDER-01: one-shot seed/hash proof from a current approved simulation. */
  musicOrderSimulationEvidence?: Record<string, ReusableMusicOrderEvidence>;
  /** SCHEDULE-01: optional subset; omitted keeps manual generation behavior unchanged. */
  targetPlaylistIds?: string[];
  /** SCHEDULE-01: canonical valid remote prefix by target. */
  preservedByTargetId?: Record<string, Candidate[]>;
  /** SCHEDULE-01: minimal remote patch proof for KEEP_FILLED targets. */
  keepFilledByTargetId?: Record<string, KeepFilledTargetPatch>;
  /** SCHEDULE-01 audit label per scoped target. */
  scheduledPolicyByTargetId?: Record<string, "KEEP_FILLED" | "REBUILD_DAILY">;
}''',
)
replace_once(GEN, "type ResolvedTargetDuration = {", "export type ResolvedTargetDuration = {")

replace_once(
    GEN,
    '''  const summary: Record<string, unknown> = {
    simulate,
    targets: [] as unknown[],''',
    '''  const targetScope = opts.targetPlaylistIds
    ? [...new Set(opts.targetPlaylistIds.filter(Boolean))]
    : null;
  const summary: Record<string, unknown> = {
    simulate,
    targetScope,
    scheduledPolicies: opts.scheduledPolicyByTargetId ?? null,
    targets: [] as unknown[],''',
)

replace_once(
    GEN,
    '''    const targets = await prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: { priority: "asc" },
    });''',
    '''    const targets = await prisma.targetPlaylist.findMany({
      where: {
        userId,
        enabled: true,
        ...(targetScope ? { id: { in: targetScope } } : {}),
      },
      orderBy: { priority: "asc" },
    });
    if (targetScope && targets.length !== targetScope.length) {
      throw new Error(
        "Um ou mais destinos agendados foram desabilitados ou removidos antes do planejamento.",
      );
    }''',
)

replace_once(
    GEN,
    '''    const incremental = await collectIncrementally({
      sources: sourceCursors,
      targets: runTargets,''',
    '''    const incremental = await collectIncrementally({
      sources: sourceCursors,
      targets: runTargets,
      preservedByTargetId: new Map(
        Object.entries(opts.preservedByTargetId ?? {}),
      ),''',
)

old_order = '''      const reusedEvidence = opts.musicOrderSimulationEvidence?.[target.id] ?? null;
      const seed =
        target.musicOrderMode === "RANDOMIZED"
          ? reusedEvidence?.seed ?? createMusicOrderSeed(run.id, target.id)
          : null;
      const ordered = applyMusicOrder(
        planned.result.items,
        target.musicOrderMode,
        seed,
        reusedEvidence ? "SIMULATION" : seed ? "RUN" : null,
      );
      planned.result.items = ordered.items;
      musicOrderEvidenceByTargetId.set(target.id, ordered.evidence);

      if (
        !simulate &&
        reusedEvidence &&
        ordered.evidence.orderHash !== reusedEvidence.orderHash
      ) {
        musicOrderPreviewViolations.push({
          targetPlaylistId: target.id,
          targetName: target.name,
          expectedOrderHash: reusedEvidence.orderHash,
          actualOrderHash: ordered.evidence.orderHash,
        });
      }'''
new_order = '''      const keepFilled = opts.keepFilledByTargetId?.[target.id] ?? null;
      const reusedEvidence = keepFilled
        ? null
        : opts.musicOrderSimulationEvidence?.[target.id] ?? null;
      const seed =
        target.musicOrderMode === "RANDOMIZED"
          ? reusedEvidence?.seed ?? createMusicOrderSeed(run.id, target.id)
          : null;
      const preservedUris = new Set(keepFilled?.preservedUris ?? []);
      const preservedPrefix: typeof planned.result.items = [];
      const orderableSuffix: typeof planned.result.items = [];
      let suffixStarted = false;
      for (const item of planned.result.items) {
        if (!suffixStarted && preservedUris.has(item.uri)) {
          preservedPrefix.push(item);
        } else {
          suffixStarted = true;
          orderableSuffix.push(item);
        }
      }
      const ordered = applyMusicOrder(
        keepFilled ? orderableSuffix : planned.result.items,
        target.musicOrderMode,
        seed,
        reusedEvidence ? "SIMULATION" : seed ? "RUN" : null,
      );
      if (keepFilled) {
        planned.result.items = [...preservedPrefix, ...ordered.items].map(
          (item, position) => ({ ...item, position }),
        );
        ordered.evidence.orderHash = playlistOrderHash(planned.result.items);
        ordered.evidence.musicCount = planned.result.items.filter(
          (item) => item.type === "MUSIC",
        ).length;
      } else {
        planned.result.items = ordered.items;
      }
      musicOrderEvidenceByTargetId.set(target.id, ordered.evidence);

      if (
        !keepFilled &&
        !simulate &&
        reusedEvidence &&
        ordered.evidence.orderHash !== reusedEvidence.orderHash
      ) {
        musicOrderPreviewViolations.push({
          targetPlaylistId: target.id,
          targetName: target.name,
          expectedOrderHash: reusedEvidence.orderHash,
          actualOrderHash: ordered.evidence.orderHash,
        });
      }'''
replace_once(GEN, old_order, new_order)

replace_once(
    GEN,
    '''      const liveTargets = await prisma.targetPlaylist.findMany({
        where: { userId, enabled: true },''',
    '''      const liveTargets = await prisma.targetPlaylist.findMany({
        where: {
          userId,
          enabled: true,
          ...(targetScope ? { id: { in: targetScope } } : {}),
        },''',
)

replace_once(
    GEN,
    '''    if (!simulate) writer = await SpotifyClient.forUser(userId);

    const targetById = new Map(targets.map((target) => [target.id, target]));''',
    '''    if (!simulate) writer = await SpotifyClient.forUser(userId);

    if (!simulate && writer) {
      const snapshotViolations: Array<{
        targetPlaylistId: string;
        targetName: string;
        expected: string;
        actual: string | null;
      }> = [];
      for (const target of targets) {
        const patch = opts.keepFilledByTargetId?.[target.id];
        if (!patch) continue;
        if (!target.spotifyPlaylistId) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected: patch.snapshotBefore,
            actual: null,
          });
          continue;
        }
        const actual = await writer.getPlaylistSnapshotId(target.spotifyPlaylistId);
        if (actual !== patch.snapshotBefore) {
          snapshotViolations.push({
            targetPlaylistId: target.id,
            targetName: target.name,
            expected: patch.snapshotBefore,
            actual,
          });
        }
      }
      if (snapshotViolations.length > 0) {
        summary.keepFilledSnapshotViolations = snapshotViolations;
        const error =
          "A manutenção foi bloqueada antes de alterar o Spotify porque a playlist mudou depois da leitura canônica. Tente novamente no próximo ciclo.";
        log({ level: "ERROR", message: error, data: snapshotViolations });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }
    }

    const targetById = new Map(targets.map((target) => [target.id, target]));''',
)

replace_once(
    GEN,
    '''        maxTracksPerArtist: target.maxTracksPerArtist,
        maxTracksPerAlbum: target.maxTracksPerAlbum,
        sequencePattern:''',
    '''        maxTracksPerArtist: target.maxTracksPerArtist,
        maxTracksPerAlbum: target.maxTracksPerAlbum,
        scheduledPolicy: opts.scheduledPolicyByTargetId?.[target.id] ?? null,
        sequencePattern:''',
)

old_write = '''        if (!simulate) {
          const playlistId = await ensureSpotifyPlaylist(writer!, target);
          await writer!.replacePlaylistItems(
            playlistId,
            items.map((item) => item.uri),
          );
          targetSummary.applied = true;
        } else {
          targetSummary.applied = false;
        }'''
new_write = '''        if (!simulate) {
          const playlistId = await ensureSpotifyPlaylist(writer!, target);
          const patch = opts.keepFilledByTargetId?.[target.id] ?? null;
          if (!patch) {
            const snapshotAfter = await writer!.replacePlaylistItems(
              playlistId,
              items.map((item) => item.uri),
            );
            targetSummary.applied = true;
            targetSummary.snapshotAfter = snapshotAfter;
          } else {
            const currentSnapshot = await writer!.getPlaylistSnapshotId(playlistId);
            if (currentSnapshot !== patch.snapshotBefore) {
              throw new Error(
                `Target "${target.name}" changed after its final maintenance preflight`,
              );
            }

            const finalUris = items.map((item) => item.uri);
            const finalUriSet = new Set(finalUris);
            const preservedUriSet = new Set(patch.preservedUris);
            const addedItems = items.filter((item) => !preservedUriSet.has(item.uri));
            const addedUris = addedItems.map((item) => item.uri);
            const addedUriSet = new Set(addedUris);
            const droppedPreservedUris = patch.preservedUris.filter(
              (uri) => !finalUriSet.has(uri),
            );
            const effectiveRemoveUris = [
              ...new Set([...patch.removeUris, ...droppedPreservedUris]),
            ];
            const forceReplace =
              patch.forceReplace ||
              effectiveRemoveUris.some((uri) => addedUriSet.has(uri));
            const preservedCandidates = opts.preservedByTargetId?.[target.id] ?? [];
            const droppedDurationMs = preservedCandidates
              .filter((item) => droppedPreservedUris.includes(item.uri))
              .reduce((sum, item) => sum + Math.max(0, item.durationMs), 0);
            const addedDurationMs = addedItems.reduce(
              (sum, item) => sum + Math.max(0, item.durationMs),
              0,
            );

            let snapshotAfter: string | null = currentSnapshot;
            let applied = false;
            if (forceReplace) {
              snapshotAfter = await writer!.replacePlaylistItems(playlistId, finalUris);
              applied = true;
            } else {
              if (addedUris.length > 0) {
                snapshotAfter =
                  (await writer!.appendPlaylistItems(playlistId, addedUris)) ??
                  snapshotAfter;
                applied = true;
              }
              if (effectiveRemoveUris.length > 0) {
                snapshotAfter =
                  (await writer!.removePlaylistItems(
                    playlistId,
                    effectiveRemoveUris,
                    snapshotAfter ?? currentSnapshot,
                  )) ?? snapshotAfter;
                applied = true;
              }
            }

            targetSummary.applied = applied;
            targetSummary.maintenanceNoop = !applied;
            targetSummary.targetDurationMs = patch.targetDurationMs;
            targetSummary.validDurationBeforeMs = patch.validDurationBeforeMs;
            targetSummary.removedDurationMs =
              patch.removedDurationMs + droppedDurationMs;
            targetSummary.addedDurationMs = addedDurationMs;
            targetSummary.preservedCount = items.length - addedItems.length;
            targetSummary.removedCount =
              patch.removedCount + droppedPreservedUris.length;
            targetSummary.addedCount = addedItems.length;
            targetSummary.unknownReplayPolicyCount = patch.unknownReplayPolicyCount;
            targetSummary.snapshotBefore = patch.snapshotBefore;
            targetSummary.snapshotAfter = snapshotAfter;
            targetSummary.minimalPatch = !forceReplace;
            targetSummary.droppedPreservedCount = droppedPreservedUris.length;
          }
        } else {
          targetSummary.applied = false;
        }'''
replace_once(GEN, old_write, new_write)

replace_once(
    GEN,
    '''            programId: item.programId,
            durationMs: item.durationMs,
          })),''',
    '''            programId: item.programId,
            durationMs: item.durationMs,
            spotifyTrackId: item.spotifyTrackId,
            primaryArtistId: item.primaryArtistId,
            albumId: item.albumId,
            originalDurationMs: item.originalDurationMs,
            resumePositionMs: item.resumePositionMs,
            sourceSpotifyType: item.sourceSpotifyType,
            sourceSpotifyId: item.sourceSpotifyId,
            sourceIncludePlayed: item.sourceIncludePlayed,
          })),''',
)

replace_once(GEN, "async function resolveTargetDuration(", "export async function resolveTargetDuration(")

# Scheduler: policy/time per target, one auditable local-date slot. ---------------
Path("src/jobs/scheduled-generation.ts").write_text(r'''import type {
  TargetPlaylist,
  TargetScheduleRun,
  TargetScheduleRunStatus,
} from "@prisma/client";

import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
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
  dailyScheduleSlot,
  isValidTimeZone,
} from "@/services/target-schedule";

import { generatePlaylists } from "./generate-playlists";

const RETRY_AFTER_MS = 30 * 60 * 1000;

type ScheduledResult = {
  userId: string;
  targetPlaylistId: string;
  scheduleRunId: string;
  runId: string;
  status: string;
};

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
          claimed.map((entry) => entry.audit.id),
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

      for (const entry of claimed) {
        scheduledPolicyByTargetId[entry.target.id] = entry.target.updatePolicy as
          | "KEEP_FILLED"
          | "REBUILD_DAILY";
        if (entry.target.updatePolicy !== "KEEP_FILLED") {
          executable.push(entry);
          continue;
        }
        try {
          const prepared = await prepareKeepFilledTarget(user.id, entry.target, now);
          if (prepared.skipReason) {
            await finishOne(entry.audit.id, "NOOP", prepared.skipReason, now, {
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
          await finishOne(entry.audit.id, "BLOCKED", reason, now);
          results.push(result(entry, "", `blocked: ${reason}`));
        }
      }

      if (executable.length === 0) continue;

      const reusable = await findReusableSimulationMusicOrderEvidence(
        user.id,
        assessment.fingerprint,
      );
      const rebuildIds = new Set(
        executable
          .filter((entry) => entry.target.updatePolicy === "REBUILD_DAILY")
          .map((entry) => entry.target.id),
      );
      const musicOrderSimulationEvidence = Object.fromEntries(
        Object.entries(reusable).filter(([targetId]) => rebuildIds.has(targetId)),
      );
      const targetPlaylistIds = executable.map((entry) => entry.target.id);
      const generated = await generatePlaylists({
        userId: user.id,
        trigger: "SCHEDULED",
        targetPlaylistIds,
        preservedByTargetId,
        keepFilledByTargetId,
        scheduledPolicyByTargetId,
        musicOrderSimulationEvidence,
      });
      const generation = await prisma.generationRun.findUnique({
        where: { id: generated.runId },
        select: { status: true, error: true, summary: true },
      });
      const targetSummaries = readTargetSummaries(generation?.summary);

      for (const entry of executable) {
        const targetSummary = targetSummaries.get(entry.target.id) ?? null;
        const status = scheduleStatus(generated.status, targetSummary);
        const reason =
          typeof targetSummary?.error === "string"
            ? targetSummary.error
            : generation?.error ?? null;
        await finishOne(entry.audit.id, status, reason, new Date(), {
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
          details: targetSummary ?? undefined,
        });
        results.push(result(entry, generated.runId, status));
      }
    } catch (error) {
      const reason = errorMessage(error);
      await finishMany(
        claimed.map((entry) => entry.audit.id),
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
    if (
      now.getTime() - existing.startedAt.getTime() < RETRY_AFTER_MS
    ) {
      return null;
    }
    return prisma.targetScheduleRun.update({
      where: { id: existing.id },
      data: {
        status: "RUNNING",
        attempt: { increment: 1 },
        generationRunId: null,
        reason: null,
        startedAt: now,
        finishedAt: null,
      },
    });
  }

  return prisma.targetScheduleRun.create({
    data: {
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
  ids: string[],
  status: TargetScheduleRunStatus,
  reason: string | null,
  finishedAt: Date,
) {
  if (ids.length === 0) return;
  await prisma.targetScheduleRun.updateMany({
    where: { id: { in: ids }, status: "RUNNING" },
    data: { status, reason, finishedAt },
  });
}

async function finishOne(
  id: string,
  status: TargetScheduleRunStatus,
  reason: string | null,
  finishedAt: Date,
  data: Record<string, unknown> = {},
) {
  await prisma.targetScheduleRun.update({
    where: { id },
    data: {
      status,
      reason,
      finishedAt,
      ...data,
    },
  });
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
''')

print("SCHEDULE-01 stage3 patch applied")
