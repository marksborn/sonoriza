-- HISTORY-02 — official Spotify Extended Streaming History provenance + audit run.
-- No existing TrackListeningEvent rows are rewritten by this migration.

ALTER TYPE "ListeningEventSource"
ADD VALUE IF NOT EXISTS 'SPOTIFY_EXTENDED_HISTORY';

CREATE TYPE "SpotifyExtendedHistoryImportStatus"
AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED');

CREATE TABLE "SpotifyExtendedHistoryImportRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "packageSha256" TEXT NOT NULL,
    "planHash" TEXT NOT NULL,
    "planVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "SpotifyExtendedHistoryImportStatus" NOT NULL DEFAULT 'RUNNING',
    "uniqueMusicEvents" INTEGER NOT NULL,
    "insertPlanned" INTEGER NOT NULL,
    "enrichPlanned" INTEGER NOT NULL,
    "quarantinePlanned" INTEGER NOT NULL,
    "insertedEvents" INTEGER NOT NULL DEFAULT 0,
    "enrichedEvents" INTEGER NOT NULL DEFAULT 0,
    "duplicateEvents" INTEGER NOT NULL DEFAULT 0,
    "noopEvents" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "SpotifyExtendedHistoryImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SpotifyExtendedHistoryImportRun_userId_startedAt_idx"
ON "SpotifyExtendedHistoryImportRun"("userId", "startedAt");

CREATE INDEX "SpotifyExtendedHistoryImportRun_userId_packageSha256_planHash_idx"
ON "SpotifyExtendedHistoryImportRun"("userId", "packageSha256", "planHash");

ALTER TABLE "SpotifyExtendedHistoryImportRun"
ADD CONSTRAINT "SpotifyExtendedHistoryImportRun_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
