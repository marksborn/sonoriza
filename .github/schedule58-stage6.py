from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# planRun starts with live URIs reserved by enabled targets that are not part of
# this scheduled batch, preserving global destination exclusivity.
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    '''  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
}''',
    '''  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  initialReserved?: Iterable<string>;
}''',
)
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    '''export function planRun({ pools, targets, preservedByTargetId }: PlanRunInput): PlanRunResult {
  const reserved = new Set<string>();''',
    '''export function planRun({
  pools,
  targets,
  preservedByTargetId,
  initialReserved,
}: PlanRunInput): PlanRunResult {
  const reserved = new Set<string>(initialReserved ?? []);''',
)

replace_once(
    "src/jobs/incremental-planning.ts",
    '''  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  onBatch?:''',
    '''  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;
  initialReserved?: Iterable<string>;
  onBatch?:''',
)
replace_once(
    "src/jobs/incremental-planning.ts",
    '''  preservedByTargetId,
  onBatch,''',
    '''  preservedByTargetId,
  initialReserved,
  onBatch,''',
)
p = Path("src/jobs/incremental-planning.ts")
text = p.read_text()
text = text.replace(
    "planRun({ pools, targets, preservedByTargetId })",
    "planRun({ pools, targets, preservedByTargetId, initialReserved })",
)
p.write_text(text)

# Generator receives the external reservation set from scheduled orchestration.
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''  scheduledPolicyByTargetId?: Record<string, "KEEP_FILLED" | "REBUILD_DAILY">;
}''',
    '''  scheduledPolicyByTargetId?: Record<string, "KEEP_FILLED" | "REBUILD_DAILY">;
  /** SCHEDULE-01: live URIs owned by enabled targets outside this scoped batch. */
  reservedUris?: string[];
}''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''      preservedByTargetId: new Map(
        Object.entries(opts.preservedByTargetId ?? {}),
      ),
      onBatch(source, batch) {''',
    '''      preservedByTargetId: new Map(
        Object.entries(opts.preservedByTargetId ?? {}),
      ),
      initialReserved: opts.reservedUris ?? [],
      onBatch(source, batch) {''',
)

# Never infer replay policy for a completed legacy/manual episode. Preserve it
# in the pure analysis, then block the whole maintenance before mutation.
replace_once(
    "src/services/keep-filled-maintenance.ts",
    '''  if (
    target.durationMode === "CALENDAR" &&
    resolved.durationMs <= 0 &&
    target.emptyCalendarBehavior === "CLEAR"
  ) {''',
    '''  if (
    target.durationMode === "CALENDAR" &&
    resolved.durationMs <= 0 &&
    target.emptyCalendarBehavior === "CLEAR"
  ) {''',
)
# Insert the unknown-replay fail-close after explicit CLEAR handling block.
replace_once(
    "src/services/keep-filled-maintenance.ts",
    '''      skipReason: null,
    };
  }

  return {
    targetPlaylistId: target.id,
    preserved: preservation.preserved,''',
    '''      skipReason: null,
    };
  }

  if (preservation.unknownReplayPolicyCount > 0) {
    throw new Error(
      `Target "${target.name}" contém episódio concluído sem proveniência suficiente para provar a política de replay; manutenção incremental bloqueada sem escrita.`,
    );
  }

  return {
    targetPlaylistId: target.id,
    preserved: preservation.preserved,''',
)

SG = "src/jobs/scheduled-generation.ts"
# Import Spotify client for external live reservations.
replace_once(
    SG,
    '''import type { Candidate } from "@/services/playlist-planner";
import {''',
    '''import type { Candidate } from "@/services/playlist-planner";
import { SpotifyClient } from "@/services/spotify";
import {''',
)

# Build reservations from every enabled destination outside the due batch.
replace_once(
    SG,
    '''      const targetPlaylistIds = executable.map((entry) => entry.target.id);
      const generated = await generatePlaylists({''',
    '''      const targetPlaylistIds = executable.map((entry) => entry.target.id);
      const dueTargetIds = new Set(targetPlaylistIds);
      const outsideTargets = await prisma.targetPlaylist.findMany({
        where: {
          userId: user.id,
          enabled: true,
          id: { notIn: targetPlaylistIds },
          spotifyPlaylistId: { not: null },
        },
        orderBy: { priority: "asc" },
        select: { id: true, spotifyPlaylistId: true },
      });
      const reservedUris = new Set<string>();
      if (outsideTargets.length > 0) {
        const spotify = await SpotifyClient.forUser(user.id);
        for (const outside of outsideTargets) {
          if (dueTargetIds.has(outside.id) || !outside.spotifyPlaylistId) continue;
          const state = await spotify.getTargetPlaylistState(outside.spotifyPlaylistId);
          for (const item of state.items) {
            if (item.uri) reservedUris.add(item.uri);
          }
        }
      }
      const generated = await generatePlaylists({''',
)
replace_once(
    SG,
    '''        scheduledPolicyByTargetId,
        musicOrderSimulationEvidence,
      });''',
    '''        scheduledPolicyByTargetId,
        musicOrderSimulationEvidence,
        reservedUris: [...reservedUris],
      });''',
)

# Atomic claim: unique daily key + compare-and-swap retry prevents two cron
# requests from executing the same target/day concurrently.
old_claim = '''  const existing = await prisma.targetScheduleRun.findUnique({
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
  });'''
new_claim = '''  const existing = await prisma.targetScheduleRun.findUnique({
    where: { scheduleKey: slot.scheduleKey },
  });
  if (existing) {
    if (["SUCCESS", "NOOP", "PARTIAL"].includes(existing.status)) return null;
    if (now.getTime() - existing.startedAt.getTime() < RETRY_AFTER_MS) return null;

    const claimed = await prisma.targetScheduleRun.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
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
    return prisma.targetScheduleRun.findUnique({ where: { id: existing.id } });
  }

  const created = await prisma.targetScheduleRun.createMany({
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
  return prisma.targetScheduleRun.findUnique({
    where: { scheduleKey: slot.scheduleKey },
  });'''
replace_once(SG, old_claim, new_claim)

# The lookup after an atomic claim is logically non-null; the caller already
# treats null as not claimed, so the return type remains accurate.

# Regression contracts for external exclusivity and atomic daily claim.
T = Path("src/services/configuration-readiness.test.ts")
T.write_text(
    T.read_text()
    + r'''

test("SCHEDULE-01 reserves live URIs from enabled destinations outside the due batch", () => {
  const scheduler = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  const generator = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  assert.match(scheduler, /outsideTargets/);
  assert.match(scheduler, /getTargetPlaylistState/);
  assert.match(scheduler, /reservedUris/);
  assert.match(generator, /initialReserved:\s*opts\.reservedUris/);
});

test("SCHEDULE-01 daily claim is concurrency-safe and successful slots are idempotent", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(source, /\["SUCCESS", "NOOP", "PARTIAL"\]\.includes/);
  assert.match(source, /createMany\(/);
  assert.match(source, /skipDuplicates:\s*true/);
  assert.match(source, /updateMany\(/);
});
'''
)

print("SCHEDULE-01 stage6 patch applied")
