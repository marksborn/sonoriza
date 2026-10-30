-- RELEASES-01 (#161) Gate 1: per-user release radar cache. Additive only.
CREATE TABLE "ReleaseRadarSnapshot" (
  "userId" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "windowDays" INTEGER NOT NULL,
  "seedCount" INTEGER NOT NULL,
  "releaseCount" INTEGER NOT NULL,
  "releases" JSONB NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReleaseRadarSnapshot_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "ReleaseRadarSnapshot_windowDays_check" CHECK ("windowDays" BETWEEN 1 AND 365)
);

ALTER TABLE "ReleaseRadarSnapshot"
  ADD CONSTRAINT "ReleaseRadarSnapshot_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
