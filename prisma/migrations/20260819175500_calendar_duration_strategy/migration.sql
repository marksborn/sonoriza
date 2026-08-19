CREATE TYPE "CalendarDurationStrategy"
AS ENUM ('SUMMED', 'PER_EVENT');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarDurationStrategy"
"CalendarDurationStrategy"
NOT NULL
DEFAULT 'SUMMED';
