CREATE TYPE "PodcastListeningStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED');

CREATE TABLE "EpisodeListeningState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyEpisodeId" TEXT NOT NULL,
    "spotifyUri" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "resumePositionMs" INTEGER NOT NULL DEFAULT 0,
    "fullyPlayed" BOOLEAN NOT NULL DEFAULT false,
    "status" "PodcastListeningStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EpisodeListeningState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EpisodeListeningState_userId_spotifyEpisodeId_key"
ON "EpisodeListeningState"("userId", "spotifyEpisodeId");

CREATE INDEX "EpisodeListeningState_userId_status_idx"
ON "EpisodeListeningState"("userId", "status");

CREATE INDEX "EpisodeListeningState_userId_lastObservedAt_idx"
ON "EpisodeListeningState"("userId", "lastObservedAt");

ALTER TABLE "EpisodeListeningState"
ADD CONSTRAINT "EpisodeListeningState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
