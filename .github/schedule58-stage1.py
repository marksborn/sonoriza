from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:80]!r}")
    p.write_text(text.replace(old, new, 1))


# Prisma schema ----------------------------------------------------------------
replace_once(
    "prisma/schema.prisma",
    "  musicIngestionRuns     MusicIngestionRun[]\n}",
    "  musicIngestionRuns     MusicIngestionRun[]\n  targetScheduleRuns     TargetScheduleRun[]\n}",
)

replace_once(
    "prisma/schema.prisma",
    "enum MusicOrderMode {\n  STANDARD\n  RANDOMIZED\n}\n",
    "enum MusicOrderMode {\n  STANDARD\n  RANDOMIZED\n}\n\nenum TargetUpdatePolicy {\n  MANUAL\n  KEEP_FILLED\n  REBUILD_DAILY\n}\n\nenum TargetScheduleRunStatus {\n  RUNNING\n  SUCCESS\n  NOOP\n  BLOCKED\n  PARTIAL\n  FAILED\n}\n",
)

replace_once(
    "prisma/schema.prisma",
    "  maxTracksPerArtist               Int?\n  maxTracksPerAlbum                Int?\n  createdAt                        DateTime                      @default(now())",
    "  maxTracksPerArtist               Int?\n  maxTracksPerAlbum                Int?\n  updatePolicy                     TargetUpdatePolicy            @default(MANUAL)\n  dailyScheduleMinutes             Int?\n  scheduleTimezone                 String?\n  createdAt                        DateTime                      @default(now())",
)

replace_once(
    "prisma/schema.prisma",
    "  user            User             @relation(fields: [userId], references: [id], onDelete: Cascade)\n  generationItems GenerationItem[]",
    "  user               User                @relation(fields: [userId], references: [id], onDelete: Cascade)\n  generationItems    GenerationItem[]\n  targetScheduleRuns TargetScheduleRun[]",
)

replace_once(
    "prisma/schema.prisma",
    "  user  User             @relation(fields: [userId], references: [id], onDelete: Cascade)\n  logs  GenerationLog[]\n  items GenerationItem[]",
    "  user         User                @relation(fields: [userId], references: [id], onDelete: Cascade)\n  logs         GenerationLog[]\n  items        GenerationItem[]\n  scheduleRuns TargetScheduleRun[]",
)

replace_once(
    "prisma/schema.prisma",
    "  programId        String?\n  durationMs       Int         @default(0)\n\n  run    GenerationRun  @relation",
    "  programId           String?\n  durationMs          Int                @default(0)\n  spotifyTrackId      String?\n  primaryArtistId     String?\n  albumId             String?\n  originalDurationMs  Int?\n  resumePositionMs    Int?\n  sourceSpotifyType   SpotifySourceType?\n  sourceSpotifyId     String?\n  sourceIncludePlayed Boolean?\n\n  run    GenerationRun  @relation",
)

schema = Path("prisma/schema.prisma")
schema.write_text(
    schema.read_text()
    + """

// ---------------------------------------------------------------------------
// SCHEDULE-01 — auditable recurring target maintenance.
// ---------------------------------------------------------------------------

model TargetScheduleRun {
  id                    String                  @id @default(cuid())
  userId                String
  targetPlaylistId      String
  scheduleKey           String                  @unique
  scheduledLocalDate    String
  scheduledForMinutes   Int
  scheduleTimezone      String
  policy                TargetUpdatePolicy
  status                TargetScheduleRunStatus @default(RUNNING)
  attempt               Int                     @default(1)
  generationRunId       String?
  targetDurationMs      Int?
  validDurationBeforeMs Int?
  removedDurationMs     Int                     @default(0)
  addedDurationMs       Int                     @default(0)
  preservedCount        Int                     @default(0)
  removedCount          Int                     @default(0)
  addedCount            Int                     @default(0)
  snapshotBefore        String?
  snapshotAfter         String?
  reason                String?                 @db.Text
  details               Json?
  startedAt             DateTime                @default(now())
  finishedAt            DateTime?

  user          User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  target        TargetPlaylist @relation(fields: [targetPlaylistId], references: [id], onDelete: Cascade)
  generationRun GenerationRun? @relation(fields: [generationRunId], references: [id], onDelete: SetNull)

  @@index([userId, startedAt])
  @@index([targetPlaylistId, startedAt])
}
"""
)

# Keep migration and Prisma relation in sync before it is ever deployed.
migration = Path("prisma/migrations/20260811190000_target_update_policy/migration.sql")
migration_text = migration.read_text()
needle = '''ALTER TABLE "TargetScheduleRun"\n  ADD CONSTRAINT "TargetScheduleRun_targetPlaylistId_fkey"\n  FOREIGN KEY ("targetPlaylistId") REFERENCES "TargetPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;\n'''
if needle not in migration_text:
    raise SystemExit("migration FK anchor missing")
migration.write_text(
    migration_text.replace(
        needle,
        needle
        + '''\nALTER TABLE "TargetScheduleRun"\n  ADD CONSTRAINT "TargetScheduleRun_generationRunId_fkey"\n  FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;\n''',
        1,
    )
)

# Candidate provenance ----------------------------------------------------------
replace_once(
    "src/services/playlist-planner/types.ts",
    '  sourceSpotifyId?: string;\n}',
    '  sourceSpotifyId?: string;\n  /** SCHEDULE-01: explicit replay policy of the source that selected a podcast. */\n  sourceIncludePlayed?: boolean;\n}',
)

replace_once(
    "src/services/spotify/incremental-reader.ts",
    "            sourceSpotifyId: options.sourceSpotifyId,\n          });",
    "            sourceSpotifyId: options.sourceSpotifyId,\n            sourceIncludePlayed: includePlayed,\n          });",
)

# Planner preserved-prefix support ---------------------------------------------
replace_once(
    "src/services/playlist-planner/planner.ts",
    "export interface PlanPlaylistInput {\n  rules: PlaylistRules;\n  pools: PlannerPools;\n  reserved?: Iterable<string>;\n}",
    "export interface PlanPlaylistInput {\n  rules: PlaylistRules;\n  pools: PlannerPools;\n  reserved?: Iterable<string>;\n  /** SCHEDULE-01: valid items already present in this target, in remote order. */\n  preserved?: Candidate[];\n}",
)

replace_once(
    "src/services/playlist-planner/planner.ts",
    "export function planPlaylist({ rules, pools, reserved }: PlanPlaylistInput): PlanResult {",
    "export function planPlaylist({ rules, pools, reserved, preserved }: PlanPlaylistInput): PlanResult {",
)

replace_once(
    "src/services/playlist-planner/planner.ts",
    "  let sequenceSlotsRequested = 0;\n  let sequenceSlotsFilled = 0;",
    "  for (const candidate of preserved ?? []) {\n    if (used.has(candidate.uri) || candidate.durationMs <= 0) continue;\n    place(candidate);\n  }\n\n  let sequenceSlotsRequested = 0;\n  let sequenceSlotsFilled = 0;",
)

replace_once(
    "src/services/playlist-planner/planner.ts",
    "      sequenceQualityPassed = true;\n      let patternIndex = 0;",
    "      sequenceQualityPassed = true;\n      let patternIndex = items.length % pattern.length;\n      sequenceSlotsRequested = items.length;\n      sequenceSlotsFilled = items.length;\n      completedCycles = Math.floor(items.length / pattern.length);",
)

# planRun threads preserved items per target -----------------------------------
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    'import type { PlanResult, PlaylistRules } from "./types";',
    'import type { Candidate, PlanResult, PlaylistRules } from "./types";',
)
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    "  targets: RunTarget[];\n}",
    "  targets: RunTarget[];\n  /** SCHEDULE-01 valid remote items keyed by target id. */\n  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;\n}",
)
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    "export function planRun({ pools, targets }: PlanRunInput): PlanRunResult {",
    "export function planRun({ pools, targets, preservedByTargetId }: PlanRunInput): PlanRunResult {",
)
replace_once(
    "src/services/playlist-planner/plan-run.ts",
    "    const result = planPlaylist({ rules: target.rules, pools, reserved });",
    "    const result = planPlaylist({\n      rules: target.rules,\n      pools,\n      reserved,\n      preserved: preservedByTargetId?.get(target.targetPlaylistId),\n    });",
)

# Incremental planning keeps the preserved prefix on every replan --------------
replace_once(
    "src/jobs/incremental-planning.ts",
    "  targets: RunTarget[];\n  onBatch?:",
    "  targets: RunTarget[];\n  preservedByTargetId?: ReadonlyMap<string, Candidate[]>;\n  onBatch?:",
)
replace_once(
    "src/jobs/incremental-planning.ts",
    ">({ sources, targets, onBatch, onRound }: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {",
    ">({\n  sources,\n  targets,\n  preservedByTargetId,\n  onBatch,\n  onRound,\n}: CollectIncrementallyOptions<TSource>): Promise<IncrementalPlanningResult<TSource>> {",
)
replace_once(
    "src/jobs/incremental-planning.ts",
    "  let plan = planRun({ pools, targets });",
    "  let plan = planRun({ pools, targets, preservedByTargetId });",
)
replace_once(
    "src/jobs/incremental-planning.ts",
    "    plan = planRun({ pools, targets });",
    "    plan = planRun({ pools, targets, preservedByTargetId });",
)

print("SCHEDULE-01 stage1 patch applied")
