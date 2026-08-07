-- CALENDAR-01: generic calendar-based duration with optional event marker.
ALTER TABLE "CalendarSelection"
RENAME COLUMN "usedForTrips" TO "usedForDuration";

CREATE TYPE "CalendarEventFilterMode" AS ENUM ('ALL', 'MARKER');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarEventFilterMode" "CalendarEventFilterMode" NOT NULL DEFAULT 'ALL',
ADD COLUMN "calendarEventMarker" TEXT;
