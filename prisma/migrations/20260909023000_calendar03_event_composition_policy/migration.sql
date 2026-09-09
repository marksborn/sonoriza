-- CALENDAR-03 Gate 1 — persistence only.
-- No planner reads this policy in Gate 1.

CREATE TYPE "EventCompositionPolicy" AS ENUM (
  'INHERIT_DESTINATION',
  'PODCAST_THEN_MUSIC'
);

CREATE TYPE "PodcastEventDistribution" AS ENUM (
  'EVERY_EVENT',
  'EVERY_N_EVENTS'
);

CREATE TABLE "CalendarEventCompositionPolicy" (
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "eventCompositionPolicy" "EventCompositionPolicy" NOT NULL DEFAULT 'INHERIT_DESTINATION',
  "maxPodcastsPerEvent" INTEGER NOT NULL DEFAULT 1,
  "podcastEventSafetyMarginSeconds" INTEGER NOT NULL DEFAULT 0,
  "podcastEventDistribution" "PodcastEventDistribution" NOT NULL DEFAULT 'EVERY_EVENT',
  "podcastEveryNEvents" INTEGER NOT NULL DEFAULT 1,
  "podcastEventOffset" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CalendarEventCompositionPolicy_pkey"
    PRIMARY KEY ("userId", "targetPlaylistId"),

  CONSTRAINT "CalendarEventCompositionPolicy_maxPodcastsPerEvent_check"
    CHECK ("maxPodcastsPerEvent" >= 1),

  CONSTRAINT "CalendarEventCompositionPolicy_safetyMargin_check"
    CHECK ("podcastEventSafetyMarginSeconds" >= 0),

  CONSTRAINT "CalendarEventCompositionPolicy_distribution_check"
    CHECK (
      (
        "podcastEventDistribution" = 'EVERY_EVENT'
        AND "podcastEveryNEvents" = 1
        AND "podcastEventOffset" = 0
      )
      OR
      (
        "podcastEventDistribution" = 'EVERY_N_EVENTS'
        AND "podcastEveryNEvents" >= 1
        AND "podcastEventOffset" >= 0
        AND "podcastEventOffset" < "podcastEveryNEvents"
      )
    )
);

CREATE INDEX "CalendarEventCompositionPolicy_userId_eventCompositionPolicy_idx"
  ON "CalendarEventCompositionPolicy"("userId", "eventCompositionPolicy");
