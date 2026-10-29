-- CALENDAR-04 (#532) — sequência reiniciada por evento.
-- Additive only: existing rows keep their policy and the new columns get
-- defaults that are ignored unless eventCompositionPolicy = SEQUENCE_PER_EVENT.

ALTER TYPE "EventCompositionPolicy" ADD VALUE IF NOT EXISTS 'SEQUENCE_PER_EVENT';

CREATE TYPE "CalendarRemainderFillStrategy" AS ENUM (
  'MUSIC_ONLY',
  'PODCAST_ONLY',
  'MIX_RATIO',
  'REPEAT_SEQUENCE'
);

CREATE TYPE "CalendarRemainderFallback" AS ENUM (
  'FILL_WITH_MUSIC',
  'LEAVE_GAP'
);

ALTER TABLE "CalendarEventCompositionPolicy"
  ADD COLUMN "remainderFillStrategy" "CalendarRemainderFillStrategy" NOT NULL DEFAULT 'MUSIC_ONLY',
  ADD COLUMN "remainderPodcastPercent" INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "remainderFallback" "CalendarRemainderFallback" NOT NULL DEFAULT 'FILL_WITH_MUSIC',
  ADD CONSTRAINT "CalendarEventCompositionPolicy_remainderPodcastPercent_check"
    CHECK ("remainderPodcastPercent" >= 0 AND "remainderPodcastPercent" <= 100);
