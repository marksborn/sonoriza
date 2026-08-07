-- CALENDAR-01: choose which calendar events drive calendar-based target duration.
CREATE TYPE "CalendarEventFilterMode" AS ENUM ('ALL', 'MARKER');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarEventFilterMode" "CalendarEventFilterMode" NOT NULL DEFAULT 'ALL',
ADD COLUMN "calendarEventMarker" TEXT;
