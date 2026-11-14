-- MUSIC-08 (#319): additive audit columns only. No row is changed; existing
-- runs keep zero / NULL and no cleanup or ingestion is triggered.
ALTER TABLE "MusicIngestionRun"
  ADD COLUMN "userExcludedCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "MusicSourceCleanupRun"
  ADD COLUMN "userExcludedUris" JSONB;
