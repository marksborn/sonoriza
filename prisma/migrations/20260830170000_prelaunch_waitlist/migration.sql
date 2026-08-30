-- PRELAUNCH-01 Gate 1 — public waitlist with explicit lifecycle and DB-backed throttling.
CREATE TYPE "PrelaunchSignupStatus" AS ENUM (
  'PENDING_CONFIRMATION',
  'WAITING',
  'INVITED',
  'ACTIVATED',
  'DECLINED',
  'UNSUBSCRIBED',
  'BOUNCED'
);

CREATE TABLE "PrelaunchSignup" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" "PrelaunchSignupStatus" NOT NULL DEFAULT 'WAITING',
  "source" TEXT NOT NULL DEFAULT 'HOME',
  "privacyVersion" TEXT NOT NULL,
  "privacyAcceptedAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "invitedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "lastSubmittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "submissionCount" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrelaunchSignup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrelaunchRateLimitBucket" (
  "keyHash" TEXT NOT NULL,
  "windowStartedAt" TIMESTAMP(3) NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrelaunchRateLimitBucket_pkey" PRIMARY KEY ("keyHash")
);

CREATE UNIQUE INDEX "PrelaunchSignup_email_key" ON "PrelaunchSignup"("email");
CREATE INDEX "PrelaunchSignup_status_createdAt_idx" ON "PrelaunchSignup"("status", "createdAt");
CREATE INDEX "PrelaunchRateLimitBucket_windowStartedAt_idx" ON "PrelaunchRateLimitBucket"("windowStartedAt");
