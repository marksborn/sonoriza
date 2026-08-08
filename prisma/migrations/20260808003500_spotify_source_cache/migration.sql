ALTER TABLE "SourcePlaylist"
  ADD COLUMN "spotifySnapshotId" TEXT,
  ADD COLUMN "cachedCandidates" JSONB,
  ADD COLUMN "cacheUpdatedAt" TIMESTAMP(3);
