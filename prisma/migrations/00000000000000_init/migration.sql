-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('MUSIC', 'PODCAST');

-- CreateEnum
CREATE TYPE "SpotifySourceType" AS ENUM ('PLAYLIST', 'SHOW');

-- CreateEnum
CREATE TYPE "DurationMode" AS ENUM ('FIXED', 'CALENDAR');

-- CreateEnum
CREATE TYPE "EmptyCalendarBehavior" AS ENUM ('CLEAR', 'KEEP', 'SKIP');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'SIMULATION');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('MUSIC', 'PODCAST');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "CalendarSelection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "googleCalendarId" TEXT NOT NULL,
    "summary" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT true,
    "usedForTrips" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CalendarSelection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourcePlaylist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "SourceKind" NOT NULL,
    "spotifyType" "SpotifySourceType" NOT NULL,
    "spotifyId" TEXT NOT NULL,
    "name" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SourcePlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetPlaylist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spotifyPlaylistId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "durationMode" "DurationMode" NOT NULL DEFAULT 'FIXED',
    "fixedDurationSeconds" INTEGER,
    "emptyCalendarBehavior" "EmptyCalendarBehavior" NOT NULL DEFAULT 'CLEAR',
    "podcastPercent" INTEGER NOT NULL DEFAULT 60,
    "sequencePattern" JSONB NOT NULL,
    "maxEpisodesPerProgram" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "simulation" BOOLEAN NOT NULL DEFAULT false,
    "status" "RunStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,
    "summary" JSONB,

    CONSTRAINT "GenerationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "targetPlaylistId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "spotifyUri" TEXT NOT NULL,
    "title" TEXT,
    "subtitle" TEXT,
    "programId" TEXT,
    "durationMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GenerationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "CalendarSelection_userId_idx" ON "CalendarSelection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarSelection_userId_googleCalendarId_key" ON "CalendarSelection"("userId", "googleCalendarId");

-- CreateIndex
CREATE INDEX "SourcePlaylist_userId_kind_idx" ON "SourcePlaylist"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "SourcePlaylist_userId_spotifyType_spotifyId_key" ON "SourcePlaylist"("userId", "spotifyType", "spotifyId");

-- CreateIndex
CREATE INDEX "TargetPlaylist_userId_priority_idx" ON "TargetPlaylist"("userId", "priority");

-- CreateIndex
CREATE INDEX "GenerationRun_userId_startedAt_idx" ON "GenerationRun"("userId", "startedAt");

-- CreateIndex
CREATE INDEX "GenerationLog_runId_createdAt_idx" ON "GenerationLog"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationItem_runId_idx" ON "GenerationItem"("runId");

-- CreateIndex
CREATE INDEX "GenerationItem_targetPlaylistId_idx" ON "GenerationItem"("targetPlaylistId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarSelection" ADD CONSTRAINT "CalendarSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourcePlaylist" ADD CONSTRAINT "SourcePlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetPlaylist" ADD CONSTRAINT "TargetPlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationLog" ADD CONSTRAINT "GenerationLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationItem" ADD CONSTRAINT "GenerationItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationItem" ADD CONSTRAINT "GenerationItem_targetPlaylistId_fkey" FOREIGN KEY ("targetPlaylistId") REFERENCES "TargetPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
