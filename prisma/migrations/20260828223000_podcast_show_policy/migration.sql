-- PODCAST-05 — per-show podcast selection policy and operational memory.
--
-- This table is intentionally separate from EpisodeListeningState. The latter
-- remains the canonical observation of Spotify playback; this table stores the
-- user's selection policy plus Sonoriza-owned sequencing/shuffle memory.

CREATE TYPE "PodcastEpisodeEligibility" AS ENUM (
    'UNPLAYED_ONLY',
    'PLAYED_ONLY',
    'ALL'
);

CREATE TYPE "PodcastShowOrder" AS ENUM (
    'OLDEST_FIRST',
    'NEWEST_FIRST',
    'RANDOM'
);

CREATE TYPE "PodcastRandomPolicy" AS ENUM (
    'WITHOUT_REPLACEMENT',
    'WITH_REPLACEMENT'
);

CREATE TYPE "PodcastExpiryPolicy" AS ENUM (
    'STRICT_EXPIRY',
    'ALLOW_IN_PROGRESS_TO_FINISH'
);

CREATE TABLE "PodcastShowPolicy" (
    "sourcePlaylistId" TEXT NOT NULL,
    "episodeEligibility" "PodcastEpisodeEligibility" NOT NULL DEFAULT 'UNPLAYED_ONLY',
    "episodeOrder" "PodcastShowOrder" NOT NULL DEFAULT 'OLDEST_FIRST',
    "randomPolicy" "PodcastRandomPolicy" NOT NULL DEFAULT 'WITHOUT_REPLACEMENT',
    "startEpisodeId" TEXT,
    "strictSequence" BOOLEAN NOT NULL DEFAULT true,
    "maxReleaseAgeDays" INTEGER,
    "expiryPolicy" "PodcastExpiryPolicy" NOT NULL DEFAULT 'STRICT_EXPIRY',
    "maxEpisodesPerCycle" INTEGER,
    "sequenceCursorEpisodeId" TEXT,
    "sequenceCompleted" BOOLEAN NOT NULL DEFAULT false,
    "randomRound" INTEGER NOT NULL DEFAULT 0,
    "randomConsumedEpisodeIds" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PodcastShowPolicy_pkey" PRIMARY KEY ("sourcePlaylistId"),
    CONSTRAINT "PodcastShowPolicy_sourcePlaylistId_fkey"
      FOREIGN KEY ("sourcePlaylistId") REFERENCES "SourcePlaylist"("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PodcastShowPolicy_maxReleaseAgeDays_check"
      CHECK ("maxReleaseAgeDays" IS NULL OR "maxReleaseAgeDays" >= 0),
    CONSTRAINT "PodcastShowPolicy_maxEpisodesPerCycle_check"
      CHECK ("maxEpisodesPerCycle" IS NULL OR "maxEpisodesPerCycle" >= 1),
    CONSTRAINT "PodcastShowPolicy_randomRound_check"
      CHECK ("randomRound" >= 0)
);

-- Existing SHOW sources inherit their current behavior. includePlayed=true was
-- historically equivalent to allowing completed episodes, so migrate it to ALL.
-- SOURCE_DEFAULT has no useful sequential contract for a configured SHOW; keep
-- the UI's established default of oldest-first for the new policy.
INSERT INTO "PodcastShowPolicy" (
    "sourcePlaylistId",
    "episodeEligibility",
    "episodeOrder"
)
SELECT
    "id",
    CASE
      WHEN "includePlayed" THEN 'ALL'::"PodcastEpisodeEligibility"
      ELSE 'UNPLAYED_ONLY'::"PodcastEpisodeEligibility"
    END,
    CASE
      WHEN "episodeOrder"::text = 'NEWEST_FIRST' THEN 'NEWEST_FIRST'::"PodcastShowOrder"
      ELSE 'OLDEST_FIRST'::"PodcastShowOrder"
    END
FROM "SourcePlaylist"
WHERE "spotifyType"::text = 'SHOW'
ON CONFLICT ("sourcePlaylistId") DO NOTHING;

-- First observed in-progress timestamp. It lets an expiring news episode finish
-- only when Sonoriza has evidence that listening began while it was still fresh.
ALTER TABLE "EpisodeListeningState"
ADD COLUMN "firstProgressObservedAt" TIMESTAMP(3);

UPDATE "EpisodeListeningState"
SET "firstProgressObservedAt" = "lastObservedAt"
WHERE "status"::text = 'IN_PROGRESS'
  AND "firstProgressObservedAt" IS NULL;