-- HISTORY-04 Gate 4: isolated pilot feedback for probable-like quality validation.
-- Intentionally no relation/FK to User in this gate so the model can live in a
-- modular Prisma fragment without changing the legacy monolithic schema file.
-- Rows are always scoped by userId at the service boundary.

CREATE TYPE "ProbableLikePilotVerdict" AS ENUM ('LIKED', 'INDIFFERENT', 'DISLIKED');

CREATE TABLE "ProbableLikePilotFeedback" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyTrackId" TEXT NOT NULL,
    "trackName" TEXT NOT NULL,
    "artistName" TEXT NOT NULL,
    "verdict" "ProbableLikePilotVerdict" NOT NULL,
    "candidateScore" INTEGER NOT NULL,
    "candidateReasons" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProbableLikePilotFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProbableLikePilotFeedback_userId_spotifyTrackId_key"
ON "ProbableLikePilotFeedback"("userId", "spotifyTrackId");

CREATE INDEX "ProbableLikePilotFeedback_userId_evaluatedAt_idx"
ON "ProbableLikePilotFeedback"("userId", "evaluatedAt");

CREATE INDEX "ProbableLikePilotFeedback_userId_verdict_evaluatedAt_idx"
ON "ProbableLikePilotFeedback"("userId", "verdict", "evaluatedAt");
