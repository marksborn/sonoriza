-- PODCAST-08 Gate 3: additive, dormant configuration. Existing destinations remain ANY.
ALTER TABLE "TargetPlaylist"
  ADD COLUMN "podcastDurationSlotBands" JSONB;

CREATE TABLE "PodcastDurationBandSettings" (
  "userId" TEXT NOT NULL,
  "shortMaxMinutes" INTEGER NOT NULL DEFAULT 30,
  "mediumMaxMinutes" INTEGER NOT NULL DEFAULT 60,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PodcastDurationBandSettings_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "PodcastDurationBandSettings_valid_limits"
    CHECK (
      "shortMaxMinutes" >= 1
      AND "mediumMaxMinutes" <= 1440
      AND "shortMaxMinutes" < "mediumMaxMinutes"
    )
);

ALTER TABLE "PodcastDurationBandSettings"
  ADD CONSTRAINT "PodcastDurationBandSettings_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
