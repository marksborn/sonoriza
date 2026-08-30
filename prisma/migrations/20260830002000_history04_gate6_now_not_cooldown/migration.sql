CREATE TYPE "HistoryProbableLikeDismissalSource" AS ENUM ('PROBABLE_LIKE');

CREATE TABLE "HistoryProbableLikeDismissal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT NOT NULL,
    "source" "HistoryProbableLikeDismissalSource" NOT NULL DEFAULT 'PROBABLE_LIKE',
    "trackName" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "candidateScore" INTEGER NOT NULL,
    "candidateReasons" JSONB NOT NULL,
    "firstDismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDismissedAt" TIMESTAMP(3) NOT NULL,
    "suppressUntil" TIMESTAMP(3) NOT NULL,
    "dismissCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoryProbableLikeDismissal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoryProbableLikeDismissal_userId_spotifyTrackId_source_key"
ON "HistoryProbableLikeDismissal"("userId", "spotifyTrackId", "source");

CREATE INDEX "HistoryProbableLikeDismissal_userId_suppressUntil_idx"
ON "HistoryProbableLikeDismissal"("userId", "suppressUntil");

CREATE INDEX "HistoryProbableLikeDismissal_userId_source_lastDismissedAt_idx"
ON "HistoryProbableLikeDismissal"("userId", "source", "lastDismissedAt");
