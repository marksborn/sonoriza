-- AUDIOBOOK-02 Gate B.2: persistent per-destination write admission fence.
-- Runs ONLY on isolated PostgreSQL for CI until explicit production approval.
CREATE TABLE "TargetAudiobookWriteFence" (
    "userId" TEXT NOT NULL,
    "spotifyPlaylistId" TEXT NOT NULL,
    "activeWrites" INTEGER NOT NULL DEFAULT 0,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TargetAudiobookWriteFence_pkey" PRIMARY KEY ("userId", "spotifyPlaylistId"),
    CONSTRAINT "TargetAudiobookWriteFence_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TargetAudiobookWriteFence_activeWrites_check" CHECK ("activeWrites" >= 0)
);
