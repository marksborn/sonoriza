-- PODCAST-02: maximum effective podcast episode duration per target.
CREATE TYPE "PodcastEpisodeMaxDurationMode" AS ENUM ('NONE', 'FIXED', 'CALENDAR_MAX_EVENT');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "podcastEpisodeMaxDurationMode" "PodcastEpisodeMaxDurationMode" NOT NULL DEFAULT 'NONE',
ADD COLUMN "podcastEpisodeMaxDurationSeconds" INTEGER;
