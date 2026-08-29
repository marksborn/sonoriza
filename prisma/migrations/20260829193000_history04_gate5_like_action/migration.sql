-- HISTORY-04 Gate 5: audit explicit LIKE confirmations originating in History.
-- Canonical preference remains LikedTrackPreference; this table preserves the
-- product-surface provenance without changing the older LIKED-01 enum.

CREATE TYPE "HistoryLikeActionSource" AS ENUM ('PROBABLE_LIKE');

CREATE TABLE "HistoryLikeAction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT NOT NULL,
    "source" "HistoryLikeActionSource" NOT NULL DEFAULT 'PROBABLE_LIKE',
    "trackName" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "primaryArtistId" TEXT,
    "candidateScore" INTEGER NOT NULL,
    "candidateReasons" JSONB NOT NULL,
    "artistAffinityUpdated" BOOLEAN NOT NULL DEFAULT false,
    "providerWriteAttempted" BOOLEAN NOT NULL DEFAULT false,
    "firstConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" TIMESTAMP(3) NOT NULL,
    "confirmCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoryLikeAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoryLikeAction_userId_spotifyTrackId_source_key"
ON "HistoryLikeAction"("userId", "spotifyTrackId", "source");

CREATE INDEX "HistoryLikeAction_userId_lastConfirmedAt_idx"
ON "HistoryLikeAction"("userId", "lastConfirmedAt");

CREATE INDEX "HistoryLikeAction_userId_source_lastConfirmedAt_idx"
ON "HistoryLikeAction"("userId", "source", "lastConfirmedAt");
