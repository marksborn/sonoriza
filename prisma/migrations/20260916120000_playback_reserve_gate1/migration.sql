-- PLAYBACK-RESERVE-01 Gate 1 — configuration persistence only.
-- No planner/runtime reads this policy and GenerationItem is unchanged.

CREATE TYPE "PlaybackReserveMode" AS ENUM (
  'NONE',
  'DURATION',
  'MUSIC_TRACKS',
  'PODCAST_EPISODES'
);

CREATE TYPE "PlaybackReservePodcastMode" AS ENUM (
  'DISABLED',
  'IF_FITS'
);

CREATE TYPE "TargetPlaybackReservePolicyMode" AS ENUM (
  'INHERIT_GLOBAL',
  'OVERRIDE'
);

-- Vocabulary reserved for the later runtime gate that will persist
-- PRIMARY/RESERVE on generated items. Gate 1 does not mutate GenerationItem.
CREATE TYPE "GenerationPlanRole" AS ENUM (
  'PRIMARY',
  'RESERVE'
);

CREATE TABLE "PlaybackReservePolicy" (
  "userId" TEXT NOT NULL,
  "reserveMode" "PlaybackReserveMode" NOT NULL DEFAULT 'NONE',
  "durationSeconds" INTEGER,
  "musicTrackCount" INTEGER,
  "podcastEpisodeCount" INTEGER,
  "podcastInDurationReserve" "PlaybackReservePodcastMode" NOT NULL DEFAULT 'DISABLED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlaybackReservePolicy_pkey" PRIMARY KEY ("userId"),

  CONSTRAINT "PlaybackReservePolicy_shape_check" CHECK (
    (
      "reserveMode" = 'NONE'
      AND "durationSeconds" IS NULL
      AND "musicTrackCount" IS NULL
      AND "podcastEpisodeCount" IS NULL
      AND "podcastInDurationReserve" = 'DISABLED'
    )
    OR
    (
      "reserveMode" = 'DURATION'
      AND "durationSeconds" >= 1
      AND "musicTrackCount" IS NULL
      AND "podcastEpisodeCount" IS NULL
    )
    OR
    (
      "reserveMode" = 'MUSIC_TRACKS'
      AND "durationSeconds" IS NULL
      AND "musicTrackCount" >= 1
      AND "podcastEpisodeCount" IS NULL
      AND "podcastInDurationReserve" = 'DISABLED'
    )
    OR
    (
      "reserveMode" = 'PODCAST_EPISODES'
      AND "durationSeconds" IS NULL
      AND "musicTrackCount" IS NULL
      AND "podcastEpisodeCount" >= 1
      AND "podcastInDurationReserve" = 'DISABLED'
    )
  )
);

CREATE INDEX "PlaybackReservePolicy_reserveMode_idx"
  ON "PlaybackReservePolicy"("reserveMode");

CREATE TABLE "TargetPlaybackReservePolicy" (
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "policyMode" "TargetPlaybackReservePolicyMode" NOT NULL DEFAULT 'INHERIT_GLOBAL',
  "reserveMode" "PlaybackReserveMode",
  "durationSeconds" INTEGER,
  "musicTrackCount" INTEGER,
  "podcastEpisodeCount" INTEGER,
  "podcastInDurationReserve" "PlaybackReservePodcastMode",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "TargetPlaybackReservePolicy_pkey"
    PRIMARY KEY ("userId", "targetPlaylistId"),

  CONSTRAINT "TargetPlaybackReservePolicy_shape_check" CHECK (
    (
      "policyMode" = 'INHERIT_GLOBAL'
      AND "reserveMode" IS NULL
      AND "durationSeconds" IS NULL
      AND "musicTrackCount" IS NULL
      AND "podcastEpisodeCount" IS NULL
      AND "podcastInDurationReserve" IS NULL
    )
    OR
    (
      "policyMode" = 'OVERRIDE'
      AND "reserveMode" IS NOT NULL
      AND "podcastInDurationReserve" IS NOT NULL
      AND (
        (
          "reserveMode" = 'NONE'
          AND "durationSeconds" IS NULL
          AND "musicTrackCount" IS NULL
          AND "podcastEpisodeCount" IS NULL
          AND "podcastInDurationReserve" = 'DISABLED'
        )
        OR
        (
          "reserveMode" = 'DURATION'
          AND "durationSeconds" >= 1
          AND "musicTrackCount" IS NULL
          AND "podcastEpisodeCount" IS NULL
        )
        OR
        (
          "reserveMode" = 'MUSIC_TRACKS'
          AND "durationSeconds" IS NULL
          AND "musicTrackCount" >= 1
          AND "podcastEpisodeCount" IS NULL
          AND "podcastInDurationReserve" = 'DISABLED'
        )
        OR
        (
          "reserveMode" = 'PODCAST_EPISODES'
          AND "durationSeconds" IS NULL
          AND "musicTrackCount" IS NULL
          AND "podcastEpisodeCount" >= 1
          AND "podcastInDurationReserve" = 'DISABLED'
        )
      )
    )
  )
);

CREATE INDEX "TargetPlaybackReservePolicy_userId_policyMode_idx"
  ON "TargetPlaybackReservePolicy"("userId", "policyMode");
