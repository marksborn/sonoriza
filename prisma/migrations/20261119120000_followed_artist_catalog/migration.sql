-- DISCOVERY-FOLLOWED-01 (#564) Gate C: per-user followed-artist catalog cache. Additive only.
CREATE TABLE "FollowedArtistCatalogSnapshot" (
  "userId" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "followedSyncedAt" TIMESTAMP(3) NOT NULL,
  "followedCount" INTEGER NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "followedArtists" JSONB NOT NULL,
  "artistChecks" JSONB NOT NULL,
  "candidates" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FollowedArtistCatalogSnapshot_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "FollowedArtistCatalogSnapshot"
  ADD CONSTRAINT "FollowedArtistCatalogSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
