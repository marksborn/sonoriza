CREATE TYPE "OnboardingStatus" AS ENUM (
  'NOT_STARTED',
  'IN_PROGRESS',
  'READY_FOR_SIMULATION',
  'COMPLETED',
  'SKIPPED'
);

CREATE TYPE "OnboardingStep" AS ENUM (
  'WELCOME',
  'SPOTIFY',
  'SPOTIFY_HISTORY',
  'SOURCES',
  'DESTINATION',
  'MUSIC_BEHAVIOR',
  'CALENDAR',
  'REVIEW',
  'SIMULATION',
  'ACTIVATION'
);

CREATE TYPE "OnboardingHistoryStatus" AS ENUM (
  'NOT_REQUESTED',
  'REQUESTED',
  'FILES_READY',
  'IMPORTING',
  'IMPORTED',
  'FAILED'
);

CREATE TABLE "OnboardingProgress" (
  "userId" TEXT NOT NULL,

  "version" INTEGER NOT NULL DEFAULT 1,
  "status" "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "currentStep" "OnboardingStep" NOT NULL DEFAULT 'WELCOME',

  "completedSteps" JSONB NOT NULL DEFAULT '[]',
  "skippedSteps" JSONB NOT NULL DEFAULT '[]',

  "historyStatus" "OnboardingHistoryStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  "historyRequestedAt" TIMESTAMP(3),
  "historyFilesReadyAt" TIMESTAMP(3),
  "historyImportedAt" TIMESTAMP(3),

  "startedAt" TIMESTAMP(3),
  "readyForSimulationAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "skippedAt" TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OnboardingProgress_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "OnboardingProgress"
ADD CONSTRAINT "OnboardingProgress_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
