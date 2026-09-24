-- MUSIC-IDENTITY-01 Gate 4E0
-- Durable, additive projection of Gate 4D same-recording representative choices.
-- No consumer/planner activation is introduced by this migration.

CREATE TYPE "CanonicalDedupeProjectionStatus" AS ENUM ('READY', 'STALE', 'REVOKED');

CREATE TABLE "CanonicalDedupeActivationProjection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "policy" TEXT NOT NULL,
  "status" "CanonicalDedupeProjectionStatus" NOT NULL DEFAULT 'READY',
  "gate4cSnapshotFingerprint" TEXT NOT NULL,
  "gate4dOrderedInputFingerprint" TEXT NOT NULL,
  "sourceScopeFingerprint" TEXT NOT NULL,
  "effectiveSourceIds" JSONB NOT NULL,
  "projectionFingerprint" TEXT NOT NULL,
  "validatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CanonicalDedupeActivationProjection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CanonicalDedupeActivationComponent" (
  "id" TEXT NOT NULL,
  "projectionId" TEXT NOT NULL,
  "componentId" TEXT NOT NULL,
  "memberProviderTrackIds" JSONB NOT NULL,
  "representativeProviderTrackId" TEXT NOT NULL,
  "preferenceState" TEXT NOT NULL,
  "containsExcludedPreference" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CanonicalDedupeActivationComponent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CanonicalDedupeActivationProjection_userId_targetPlaylistId_policy_version_key"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "policy", "version");

CREATE UNIQUE INDEX "CanonicalDedupeActivationProjection_userId_targetPlaylistId_policy_projectionFingerprint_key"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "policy", "projectionFingerprint");

CREATE INDEX "CanonicalDedupeActivationProjection_userId_targetPlaylistId_status_idx"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "status");

CREATE INDEX "CanonicalDedupeActivationProjection_userId_policy_status_idx"
  ON "CanonicalDedupeActivationProjection"("userId", "policy", "status");

CREATE UNIQUE INDEX "CanonicalDedupeActivationComponent_projectionId_componentId_key"
  ON "CanonicalDedupeActivationComponent"("projectionId", "componentId");

CREATE INDEX "CanonicalDedupeActivationComponent_projectionId_representativeProviderTrackId_idx"
  ON "CanonicalDedupeActivationComponent"("projectionId", "representativeProviderTrackId");

ALTER TABLE "CanonicalDedupeActivationComponent"
  ADD CONSTRAINT "CanonicalDedupeActivationComponent_projectionId_fkey"
  FOREIGN KEY ("projectionId") REFERENCES "CanonicalDedupeActivationProjection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
