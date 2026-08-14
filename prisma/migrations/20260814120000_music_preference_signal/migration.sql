-- CreateEnum
CREATE TYPE "MusicPreferenceSignalType" AS ENUM ('INFERRED_SKIP');

-- CreateTable
CREATE TABLE "MusicPreferenceSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT NOT NULL,
    "spotifyUri" TEXT,
    "type" "MusicPreferenceSignalType" NOT NULL,
    "sourceGenerationRunId" TEXT NOT NULL,
    "targetPlaylistId" TEXT NOT NULL,
    "generationItemId" TEXT,
    "position" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "evidence" JSONB,
    "inferredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "consumedByRunId" TEXT,

    CONSTRAINT "MusicPreferenceSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MusicPreferenceSignal_userId_type_sourceGenerationRunId_tar_key" ON "MusicPreferenceSignal"("userId", "type", "sourceGenerationRunId", "targetPlaylistId", "position");

-- CreateIndex
CREATE INDEX "MusicPreferenceSignal_userId_targetPlaylistId_type_consumed_idx" ON "MusicPreferenceSignal"("userId", "targetPlaylistId", "type", "consumedAt");

-- CreateIndex
CREATE INDEX "MusicPreferenceSignal_userId_spotifyTrackId_idx" ON "MusicPreferenceSignal"("userId", "spotifyTrackId");

-- AddForeignKey
ALTER TABLE "MusicPreferenceSignal" ADD CONSTRAINT "MusicPreferenceSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
