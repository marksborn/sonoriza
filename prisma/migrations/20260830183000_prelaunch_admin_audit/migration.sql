-- PRELAUNCH-01 Gate 4: append-only audit trail for administrative status changes.
CREATE TABLE "PrelaunchSignupStatusEvent" (
  "id" TEXT NOT NULL,
  "prelaunchSignupId" TEXT NOT NULL,
  "previousStatus" "PrelaunchSignupStatus" NOT NULL,
  "status" "PrelaunchSignupStatus" NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorEmail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PrelaunchSignupStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrelaunchSignupStatusEvent_prelaunchSignupId_createdAt_idx"
  ON "PrelaunchSignupStatusEvent"("prelaunchSignupId", "createdAt");

CREATE INDEX "PrelaunchSignupStatusEvent_actorUserId_createdAt_idx"
  ON "PrelaunchSignupStatusEvent"("actorUserId", "createdAt");

ALTER TABLE "PrelaunchSignupStatusEvent"
  ADD CONSTRAINT "PrelaunchSignupStatusEvent_prelaunchSignupId_fkey"
  FOREIGN KEY ("prelaunchSignupId") REFERENCES "PrelaunchSignup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
