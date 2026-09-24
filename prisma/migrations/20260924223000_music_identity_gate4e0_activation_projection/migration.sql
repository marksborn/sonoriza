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

CREATE UNIQUE INDEX "gate4e0_projection_version_uq"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "policy", "version");

CREATE UNIQUE INDEX "gate4e0_projection_fingerprint_uq"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "policy", "projectionFingerprint");

CREATE INDEX "gate4e0_projection_target_status_idx"
  ON "CanonicalDedupeActivationProjection"("userId", "targetPlaylistId", "status");

CREATE INDEX "gate4e0_projection_policy_status_idx"
  ON "CanonicalDedupeActivationProjection"("userId", "policy", "status");

CREATE UNIQUE INDEX "gate4e0_component_component_uq"
  ON "CanonicalDedupeActivationComponent"("projectionId", "componentId");

CREATE INDEX "gate4e0_component_rep_idx"
  ON "CanonicalDedupeActivationComponent"("projectionId", "representativeProviderTrackId");

ALTER TABLE "CanonicalDedupeActivationComponent"
  ADD CONSTRAINT "gate4e0_component_projection_fk"
  FOREIGN KEY ("projectionId") REFERENCES "CanonicalDedupeActivationProjection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
