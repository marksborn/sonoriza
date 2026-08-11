CREATE TYPE "TargetUpdatePolicy" AS ENUM ('MANUAL', 'KEEP_FILLED', 'REBUILD_DAILY');
CREATE TYPE "TargetScheduleRunStatus" AS ENUM ('RUNNING', 'SUCCESS', 'NOOP', 'BLOCKED', 'PARTIAL', 'FAILED');

ALTER TABLE "TargetPlaylist"
  ADD COLUMN "updatePolicy" "TargetUpdatePolicy" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "dailyScheduleMinutes" INTEGER,
  ADD COLUMN "scheduleTimezone" TEXT;

ALTER TABLE "TargetPlaylist"
  ADD CONSTRAINT "TargetPlaylist_dailyScheduleMinutes_check"
  CHECK ("dailyScheduleMinutes" IS NULL OR "dailyScheduleMinutes" BETWEEN 0 AND 1439);

ALTER TABLE "GenerationItem"
  ADD COLUMN "spotifyTrackId" TEXT,
  ADD COLUMN "primaryArtistId" TEXT,
  ADD COLUMN "albumId" TEXT,
  ADD COLUMN "originalDurationMs" INTEGER,
  ADD COLUMN "resumePositionMs" INTEGER,
  ADD COLUMN "sourceSpotifyType" "SpotifySourceType",
  ADD COLUMN "sourceSpotifyId" TEXT,
  ADD COLUMN "sourceIncludePlayed" BOOLEAN;

CREATE TABLE "TargetScheduleRun" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "scheduleKey" TEXT NOT NULL,
  "scheduledLocalDate" TEXT NOT NULL,
  "scheduledForMinutes" INTEGER NOT NULL,
  "scheduleTimezone" TEXT NOT NULL,
  "policy" "TargetUpdatePolicy" NOT NULL,
  "status" "TargetScheduleRunStatus" NOT NULL DEFAULT 'RUNNING',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "generationRunId" TEXT,
  "targetDurationMs" INTEGER,
  "validDurationBeforeMs" INTEGER,
  "removedDurationMs" INTEGER NOT NULL DEFAULT 0,
  "addedDurationMs" INTEGER NOT NULL DEFAULT 0,
  "preservedCount" INTEGER NOT NULL DEFAULT 0,
  "removedCount" INTEGER NOT NULL DEFAULT 0,
  "addedCount" INTEGER NOT NULL DEFAULT 0,
  "snapshotBefore" TEXT,
  "snapshotAfter" TEXT,
  "reason" TEXT,
  "details" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),

  CONSTRAINT "TargetScheduleRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TargetScheduleRun_scheduleKey_key" ON "TargetScheduleRun"("scheduleKey");
CREATE INDEX "TargetScheduleRun_userId_startedAt_idx" ON "TargetScheduleRun"("userId", "startedAt");
CREATE INDEX "TargetScheduleRun_targetPlaylistId_startedAt_idx" ON "TargetScheduleRun"("targetPlaylistId", "startedAt");

ALTER TABLE "TargetScheduleRun"
  ADD CONSTRAINT "TargetScheduleRun_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetScheduleRun"
  ADD CONSTRAINT "TargetScheduleRun_targetPlaylistId_fkey"
  FOREIGN KEY ("targetPlaylistId") REFERENCES "TargetPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetScheduleRun"
  ADD CONSTRAINT "TargetScheduleRun_generationRunId_fkey"
  FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
