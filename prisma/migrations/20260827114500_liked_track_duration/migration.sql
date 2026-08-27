ALTER TABLE "LikedTrackPreference"
ADD COLUMN "durationMs" INTEGER;

ALTER TABLE "LikedTrackPreference"
ADD CONSTRAINT "LikedTrackPreference_durationMs_positive"
CHECK ("durationMs" IS NULL OR "durationMs" > 0);
