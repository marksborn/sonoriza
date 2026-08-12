CREATE TYPE "ListeningEventSource" AS ENUM ('SPOTIFY_RECENTLY_PLAYED', 'LASTFM_SCROBBLE', 'IMPORT');
CREATE TYPE "LastFmBackfillStatus" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TABLE "TrackListeningEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT,
    "spotifyUri" TEXT,
    "trackName" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "primaryArtistId" TEXT,
    "albumName" TEXT,
    "albumId" TEXT,
    "isrc" TEXT,
    "trackMbid" TEXT,
    "artistMbid" TEXT,
    "albumMbid" TEXT,
    "playedAt" TIMESTAMP(3) NOT NULL,
    "source" "ListeningEventSource" NOT NULL,
    "sourceEventKey" TEXT NOT NULL,
    "contextType" TEXT,
    "contextUri" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackListeningEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LastFmBackfillRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" "LastFmBackfillStatus" NOT NULL DEFAULT 'RUNNING',
    "from" TIMESTAMP(3),
    "to" TIMESTAMP(3) NOT NULL,
    "nextPage" INTEGER NOT NULL DEFAULT 1,
    "totalPages" INTEGER,
    "profilePlayCount" INTEGER,
    "scannedProviderRows" INTEGER NOT NULL DEFAULT 0,
    "acceptedEvents" INTEGER NOT NULL DEFAULT 0,
    "insertedEvents" INTEGER NOT NULL DEFAULT 0,
    "duplicateEvents" INTEGER NOT NULL DEFAULT 0,
    "nowPlayingSkipped" INTEGER NOT NULL DEFAULT 0,
    "invalidSkipped" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPageAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "LastFmBackfillRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackListeningEvent_userId_source_sourceEventKey_key"
ON "TrackListeningEvent"("userId", "source", "sourceEventKey");

CREATE INDEX "TrackListeningEvent_userId_playedAt_idx"
ON "TrackListeningEvent"("userId", "playedAt");

CREATE INDEX "TrackListeningEvent_userId_spotifyTrackId_playedAt_idx"
ON "TrackListeningEvent"("userId", "spotifyTrackId", "playedAt");

CREATE INDEX "TrackListeningEvent_userId_artistName_trackName_playedAt_idx"
ON "TrackListeningEvent"("userId", "artistName", "trackName", "playedAt");

CREATE INDEX "LastFmBackfillRun_userId_startedAt_idx"
ON "LastFmBackfillRun"("userId", "startedAt");

CREATE INDEX "LastFmBackfillRun_userId_username_status_idx"
ON "LastFmBackfillRun"("userId", "username", "status");

ALTER TABLE "TrackListeningEvent"
ADD CONSTRAINT "TrackListeningEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LastFmBackfillRun"
ADD CONSTRAINT "LastFmBackfillRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
