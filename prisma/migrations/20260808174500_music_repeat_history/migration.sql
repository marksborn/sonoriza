CREATE TYPE "MusicRepeatWindowUnit" AS ENUM ('DAYS', 'MONTHS', 'YEARS');

CREATE TABLE "MusicPlaybackPolicy" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "windowValue" INTEGER,
    "windowUnit" "MusicRepeatWindowUnit",
    "historyKnownSince" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "syncAfterCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicPlaybackPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrackListeningState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT NOT NULL,
    "spotifyUri" TEXT,
    "lastPlayedAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackListeningState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MusicPlaybackPolicy_userId_key" ON "MusicPlaybackPolicy"("userId");
CREATE UNIQUE INDEX "TrackListeningState_userId_spotifyTrackId_key" ON "TrackListeningState"("userId", "spotifyTrackId");
CREATE INDEX "TrackListeningState_userId_lastPlayedAt_idx" ON "TrackListeningState"("userId", "lastPlayedAt");

ALTER TABLE "MusicPlaybackPolicy"
ADD CONSTRAINT "MusicPlaybackPolicy_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackListeningState"
ADD CONSTRAINT "TrackListeningState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
