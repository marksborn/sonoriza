-- CALENDAR #127 Gate 3
-- Evolve the single TargetPlaylist -> CalendarSelection binding to an explicit
-- multi-calendar scope while preserving every Gate 2 binding and legacy target.

CREATE TYPE "TargetCalendarMode" AS ENUM ('LEGACY_GLOBAL', 'SELECTED', 'ALL_QUERYABLE');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarMode" "TargetCalendarMode" NOT NULL DEFAULT 'LEGACY_GLOBAL';

CREATE TABLE "TargetPlaylistCalendar" (
    "targetPlaylistId" TEXT NOT NULL,
    "calendarSelectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetPlaylistCalendar_pkey" PRIMARY KEY ("targetPlaylistId", "calendarSelectionId")
);

CREATE INDEX "TargetPlaylistCalendar_calendarSelectionId_idx"
ON "TargetPlaylistCalendar"("calendarSelectionId");

ALTER TABLE "TargetPlaylistCalendar"
ADD CONSTRAINT "TargetPlaylistCalendar_targetPlaylistId_fkey"
FOREIGN KEY ("targetPlaylistId") REFERENCES "TargetPlaylist"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetPlaylistCalendar"
ADD CONSTRAINT "TargetPlaylistCalendar_calendarSelectionId_fkey"
FOREIGN KEY ("calendarSelectionId") REFERENCES "CalendarSelection"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TargetPlaylistCalendar" ("targetPlaylistId", "calendarSelectionId")
SELECT "id", "calendarSelectionId"
FROM "TargetPlaylist"
WHERE "calendarSelectionId" IS NOT NULL;

UPDATE "TargetPlaylist"
SET "calendarMode" = 'SELECTED'
WHERE "calendarSelectionId" IS NOT NULL;

ALTER TABLE "TargetPlaylist"
DROP CONSTRAINT "TargetPlaylist_calendarSelectionId_fkey";

DROP INDEX "TargetPlaylist_calendarSelectionId_idx";

ALTER TABLE "TargetPlaylist"
DROP COLUMN "calendarSelectionId";
