-- PODCAST-07 Gate 1 — persistence contract only.
-- No planner/runtime read, Spotify call, Spotify write or fingerprint change is
-- enabled by this migration.

CREATE TYPE "PodcastSavedEpisodesFrequencyScope" AS ENUM ('PER_SHOW', 'GLOBAL_POOL');
CREATE TYPE "PodcastShowEpisodeScope" AS ENUM ('ALL_EPISODES', 'SAVED_ONLY');

-- Existing explicit SHOW policies keep their current behavior. The new field is
-- non-null and defaults to the pre-PODCAST-07 semantic: full SHOW catalogue.
ALTER TABLE "PodcastShowPolicy"
  ADD COLUMN "showEpisodeScope" "PodcastShowEpisodeScope" NOT NULL DEFAULT 'ALL_EPISODES';

-- SAVED_EPISODES gets its own default policy. No rows are backfilled: absence of
-- a row remains the neutral/backward-compatible state until the user explicitly
-- configures the source.
CREATE TABLE "PodcastSavedEpisodesPolicy" (
  "sourcePlaylistId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "episodeOrder" "PodcastShowOrder" NOT NULL DEFAULT 'RANDOM',
  "randomPolicy" "PodcastRandomPolicy" NOT NULL DEFAULT 'WITHOUT_REPLACEMENT',
  "cadenceMaxEpisodes" INTEGER,
  "cadenceUnit" "PodcastCadenceUnit",
  "frequencyScope" "PodcastSavedEpisodesFrequencyScope" NOT NULL DEFAULT 'PER_SHOW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PodcastSavedEpisodesPolicy_pkey" PRIMARY KEY ("sourcePlaylistId")
);

CREATE UNIQUE INDEX "PodcastSavedEpisodesPolicy_userId_sourcePlaylistId_key"
  ON "PodcastSavedEpisodesPolicy"("userId", "sourcePlaylistId");

CREATE INDEX "PodcastSavedEpisodesPolicy_userId_idx"
  ON "PodcastSavedEpisodesPolicy"("userId");

ALTER TABLE "PodcastSavedEpisodesPolicy"
  ADD CONSTRAINT "PodcastSavedEpisodesPolicy_userId_sourcePlaylistId_fkey"
  FOREIGN KEY ("userId", "sourcePlaylistId")
  REFERENCES "SourcePlaylist"("userId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- V1 cadence is weekly only and must be either completely unset or completely
-- specified with a positive episode budget.
ALTER TABLE "PodcastSavedEpisodesPolicy"
  ADD CONSTRAINT "PodcastSavedEpisodesPolicy_cadence_pair_check"
  CHECK (
    ("cadenceMaxEpisodes" IS NULL AND "cadenceUnit" IS NULL)
    OR
    (
      "cadenceMaxEpisodes" IS NOT NULL
      AND "cadenceMaxEpisodes" >= 1
      AND "cadenceUnit" = 'WEEK'
    )
  );
