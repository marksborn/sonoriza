-- SCHEDULE-01 / #226
-- Preserve each retry attempt as immutable audit evidence while keeping
-- TargetScheduleRun as the aggregate state for the daily schedule slot.

CREATE TABLE "TargetScheduleAttempt" (
    "id" TEXT NOT NULL,
    "targetScheduleRunId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "TargetScheduleRunStatus" NOT NULL DEFAULT 'RUNNING',
    "generationRunId" TEXT,
    "reason" TEXT,
    "details" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TargetScheduleAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetScheduleAttempt_targetScheduleRunId_attempt_key"
ON "TargetScheduleAttempt"("targetScheduleRunId", "attempt");

CREATE INDEX "TargetScheduleAttempt_targetScheduleRunId_startedAt_idx"
ON "TargetScheduleAttempt"("targetScheduleRunId", "startedAt");

CREATE INDEX "TargetScheduleAttempt_generationRunId_idx"
ON "TargetScheduleAttempt"("generationRunId");

ALTER TABLE "TargetScheduleAttempt"
ADD CONSTRAINT "TargetScheduleAttempt_targetScheduleRunId_fkey"
FOREIGN KEY ("targetScheduleRunId") REFERENCES "TargetScheduleRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetScheduleAttempt"
ADD CONSTRAINT "TargetScheduleAttempt_generationRunId_fkey"
FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Historical retries that were already overwritten cannot be reconstructed.
-- Backfill only the currently known/final attempt for each existing schedule.
INSERT INTO "TargetScheduleAttempt" (
    "id",
    "targetScheduleRunId",
    "attempt",
    "status",
    "generationRunId",
    "reason",
    "details",
    "startedAt",
    "finishedAt"
)
SELECT
    'legacy-' || "id" || '-' || "attempt"::text,
    "id",
    "attempt",
    "status",
    "generationRunId",
    "reason",
    "details",
    "startedAt",
    "finishedAt"
FROM "TargetScheduleRun";
