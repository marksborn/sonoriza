-- CALENDAR #127 Gate 1
-- Persist an optional calendar selection on each target playlist.
-- Existing targets remain NULL so production behavior is preserved until a
-- target is explicitly migrated to a per-playlist calendar in a later gate.

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarSelectionId" TEXT;

CREATE INDEX "TargetPlaylist_calendarSelectionId_idx"
ON "TargetPlaylist"("calendarSelectionId");

ALTER TABLE "TargetPlaylist"
ADD CONSTRAINT "TargetPlaylist_calendarSelectionId_fkey"
FOREIGN KEY ("calendarSelectionId") REFERENCES "CalendarSelection"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
