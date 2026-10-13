-- FEATURE-PARITY-B1.3: explicit per-destination productive Reserve opt-in.
-- Default is OFF; neither a policy nor a legacy pilot allowlist implies consent.
CREATE TABLE "TargetPlaybackReserveActivation" (
  "userId" TEXT NOT NULL,
  "targetPlaylistId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TargetPlaybackReserveActivation_pkey"
    PRIMARY KEY ("userId", "targetPlaylistId")
);

CREATE INDEX "TargetPlaybackReserveActivation_userId_enabled_idx"
ON "TargetPlaybackReserveActivation"("userId", "enabled");

ALTER TABLE "TargetPlaybackReserveActivation"
ADD CONSTRAINT "TargetPlaybackReserveActivation_userId_targetPlaylistId_fkey"
FOREIGN KEY ("userId", "targetPlaylistId")
REFERENCES "TargetPlaylist"("userId", "id")
ON DELETE CASCADE ON UPDATE CASCADE;
