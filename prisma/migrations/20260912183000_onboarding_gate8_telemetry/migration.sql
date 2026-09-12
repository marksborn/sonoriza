CREATE TABLE "OnboardingTelemetryEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "event" TEXT NOT NULL,
  "step" "OnboardingStep",
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OnboardingTelemetryEvent_pkey"
    PRIMARY KEY ("id")
);

CREATE INDEX
  "OnboardingTelemetryEvent_userId_createdAt_idx"
ON "OnboardingTelemetryEvent"("userId", "createdAt");

CREATE INDEX
  "OnboardingTelemetryEvent_event_createdAt_idx"
ON "OnboardingTelemetryEvent"("event", "createdAt");

CREATE INDEX
  "OnboardingTelemetryEvent_step_createdAt_idx"
ON "OnboardingTelemetryEvent"("step", "createdAt");

ALTER TABLE "OnboardingTelemetryEvent"
ADD CONSTRAINT "OnboardingTelemetryEvent_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
