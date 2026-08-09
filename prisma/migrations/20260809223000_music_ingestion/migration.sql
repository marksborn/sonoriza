CREATE TYPE "MusicIngestionRuleType" AS ENUM ('PLAYLIST_COPY', 'SAVED_TRACK', 'SAVED_TRACK_ALBUM');
CREATE TYPE "MusicIngestionInitialMode" AS ENUM ('FROM_NOW', 'IMPORT_CURRENT');
CREATE TYPE "MusicIngestionCapabilityStatus" AS ENUM ('UNKNOWN', 'SUPPORTED', 'BLOCKED');
CREATE TYPE "MusicIngestionTrigger" AS ENUM ('INITIAL_BASELINE', 'INITIAL_IMPORT', 'USER_SYNC', 'SCHEDULED', 'MANUAL');
CREATE TYPE "MusicIngestionRunStatus" AS ENUM ('PREVIEW', 'SUCCESS', 'PARTIAL', 'FAILED', 'NOOP');

CREATE TABLE "MusicIngestionRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetSourcePlaylistId" TEXT NOT NULL,
    "type" "MusicIngestionRuleType" NOT NULL,
    "sourceSpotifyId" TEXT,
    "sourceName" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "initialMode" "MusicIngestionInitialMode" NOT NULL DEFAULT 'FROM_NOW',
    "state" JSONB,
    "capabilityStatus" "MusicIngestionCapabilityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "capabilityMessage" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicIngestionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MusicIngestionRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ruleId" TEXT,
    "targetSourcePlaylistId" TEXT NOT NULL,
    "ruleType" "MusicIngestionRuleType",
    "trigger" "MusicIngestionTrigger" NOT NULL,
    "status" "MusicIngestionRunStatus" NOT NULL,
    "preview" BOOLEAN NOT NULL DEFAULT false,
    "sourceEventCount" INTEGER NOT NULL DEFAULT 0,
    "addedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "cooldownCount" INTEGER NOT NULL DEFAULT 0,
    "unavailableCount" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MusicIngestionRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MusicIngestionRule_userId_enabled_idx" ON "MusicIngestionRule"("userId", "enabled");
CREATE INDEX "MusicIngestionRule_targetSourcePlaylistId_idx" ON "MusicIngestionRule"("targetSourcePlaylistId");
CREATE INDEX "MusicIngestionRun_userId_startedAt_idx" ON "MusicIngestionRun"("userId", "startedAt");
CREATE INDEX "MusicIngestionRun_ruleId_startedAt_idx" ON "MusicIngestionRun"("ruleId", "startedAt");
CREATE INDEX "MusicIngestionRun_targetSourcePlaylistId_startedAt_idx" ON "MusicIngestionRun"("targetSourcePlaylistId", "startedAt");

ALTER TABLE "MusicIngestionRule"
ADD CONSTRAINT "MusicIngestionRule_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MusicIngestionRule"
ADD CONSTRAINT "MusicIngestionRule_targetSourcePlaylistId_fkey"
FOREIGN KEY ("targetSourcePlaylistId") REFERENCES "SourcePlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MusicIngestionRun"
ADD CONSTRAINT "MusicIngestionRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MusicIngestionRun"
ADD CONSTRAINT "MusicIngestionRun_ruleId_fkey"
FOREIGN KEY ("ruleId") REFERENCES "MusicIngestionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MusicIngestionRun"
ADD CONSTRAINT "MusicIngestionRun_targetSourcePlaylistId_fkey"
FOREIGN KEY ("targetSourcePlaylistId") REFERENCES "SourcePlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
