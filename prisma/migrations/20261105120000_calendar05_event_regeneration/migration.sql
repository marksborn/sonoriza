-- CALENDAR-05 (#553): opt-in regeneration per calendar event. Additive only;
-- existing rows stay on the daily schedule.
ALTER TABLE "CalendarEventCompositionPolicy"
  ADD COLUMN "regenerateOnEvent" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "eventRegenerationLeadMinutes" INTEGER NOT NULL DEFAULT 15,
  ADD CONSTRAINT "CalendarEventCompositionPolicy_eventRegenerationLead_check"
    CHECK ("eventRegenerationLeadMinutes" IN (5, 15, 30));
