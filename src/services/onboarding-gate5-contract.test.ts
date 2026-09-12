import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const onboarding = () =>
  readFileSync(
    "src/app/onboarding/page.tsx",
    "utf8",
  );

const calendarService = () =>
  readFileSync(
    "src/services/onboarding/basic-calendar.ts",
    "utf8",
  );

const normalCalendar = () =>
  readFileSync(
    "src/app/dashboard/configuracao/calendarios/page.tsx",
    "utf8",
  );

const normalDestination = () =>
  readFileSync(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    "utf8",
  );

test("#205 Gate 5 makes calendar optional and advances to review", () => {
  const source = onboarding();

  assert.match(
    source,
    /from: "CALENDAR",\s+to: "REVIEW",\s+markSkipped: true/,
  );

  assert.match(
    source,
    /from: "CALENDAR",\s+to: "REVIEW",\s+markCompleted: true/,
  );

  assert.match(
    source,
    /Não usar calendário agora/,
  );
});

test("#205 Gate 5 lazy-loads Google only on CALENDAR", () => {
  const source = onboarding();

  assert.match(
    source,
    /currentStep === "CALENDAR" &&\s+googleAccount/,
  );

  assert.match(
    source,
    /listOnboardingCalendarOptions/,
  );
});

test("#205 Gate 5 supports Google connect and reconnect", () => {
  const source = onboarding();

  assert.match(
    source,
    /signIn\("google"/,
  );

  assert.match(
    source,
    /Conectar Google Agenda/,
  );

  assert.match(
    source,
    /Reconectar Google Agenda/,
  );
});

test("#205 Gate 5 reuses existing calendar contracts", () => {
  const service = calendarService();

  assert.match(
    service,
    /normalizeTargetCalendarSelectionIds/,
  );

  assert.match(
    normalDestination(),
    /normalizeTargetCalendarSelectionIds/,
  );

  assert.match(
    service,
    /targetPlaylistCalendar/,
  );

  assert.match(
    normalDestination(),
    /targetPlaylistCalendar/,
  );

  assert.match(
    service,
    /GoogleCalendarClient/,
  );

  assert.match(
    normalCalendar(),
    /GoogleCalendarClient/,
  );
});

test("#205 Gate 5 persists target SELECTED scope with safe defaults", () => {
  const service = calendarService();

  assert.match(
    service,
    /DurationMode\.CALENDAR/,
  );

  assert.match(
    service,
    /fixedDurationSeconds: null/,
  );

  assert.match(
    service,
    /TargetCalendarMode\.SELECTED/,
  );

  assert.match(
    service,
    /EmptyCalendarBehavior\.KEEP/,
  );

  assert.match(
    service,
    /CalendarEventFilterMode\.ALL/,
  );

  assert.match(
    service,
    /CalendarDurationStrategy\.SUMMED/,
  );
});

test("#205 Gate 5 remains user scoped", () => {
  const service = calendarService();

  assert.match(
    service,
    /id: input\.targetId,\s+userId: input\.userId/,
  );

  assert.match(
    service,
    /userId_googleCalendarId/,
  );
});

test("#205 Gate 5 does not activate, schedule or generate", () => {
  const service = calendarService();
  const page = onboarding();

  assert.doesNotMatch(
    service,
    /enabled\s*:/,
  );

  assert.doesNotMatch(
    service,
    /updatePolicy\s*:/,
  );

  assert.doesNotMatch(
    page,
    /replacePlaylistItems/,
  );

  assert.doesNotMatch(
    page,
    /\/api\/generate/,
  );

  assert.match(
    page,
    /currentStep === "REVIEW"/,
  );
});
