CREATE TYPE "MusicSourceRetentionMode" AS ENUM ('KEEP_ALL', 'REMOVE_AFTER_PLAYED');
CREATE TYPE "MusicSourceCleanupStatus" AS ENUM ('PREVIEW', 'SUCCESS', 'PARTIAL', 'FAILED', 'STALE');

ALTER TABLE "SourcePlaylist"
ADD COLUMN "musicRetentionMode" "MusicSourceRetentionMode" NOT NULL DEFAULT 'KEEP_ALL',
ADD COLUMN "musicCleanupAutomationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "musicCleanupFirstCompletedAt" TIMESTAMP(3),
ADD COLUMN "musicCleanupLastRunAt" TIMESTAMP(3);

CREATE TABLE "MusicSourceCleanupRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourcePlaylistId" TEXT NOT NULL,
    "status" "MusicSourceCleanupStatus" NOT NULL DEFAULT 'PREVIEW',
    "snapshotBefore" TEXT NOT NULL,
    "snapshotAfter" TEXT,
    "planHash" TEXT NOT NULL,
    "examinedCount" INTEGER NOT NULL,
    "removableTrackCount" INTEGER NOT NULL,
    "removalOccurrenceCount" INTEGER NOT NULL,
    "keptCount" INTEGER NOT NULL,
    "plannedUris" JSONB NOT NULL,
    "removedUris" JSONB,
    "failedUris" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MusicSourceCleanupRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MusicSourceCleanupRun_userId_startedAt_idx"
ON "MusicSourceCleanupRun"("userId", "startedAt");

CREATE INDEX "MusicSourceCleanupRun_sourcePlaylistId_startedAt_idx"
ON "MusicSourceCleanupRun"("sourcePlaylistId", "startedAt");

ALTER TABLE "MusicSourceCleanupRun"
ADD CONSTRAINT "MusicSourceCleanupRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MusicSourceCleanupRun"
ADD CONSTRAINT "MusicSourceCleanupRun_sourcePlaylistId_fkey"
FOREIGN KEY ("sourcePlaylistId") REFERENCES "SourcePlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
