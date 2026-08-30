-- PRELAUNCH-01 Gate 5: expiring, revocable invitations.
CREATE TABLE "PrelaunchInvite" (
  "id" TEXT NOT NULL,
  "prelaunchSignupId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expectedEmail" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdByEmail" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PrelaunchInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PrelaunchInvite_tokenHash_key"
  ON "PrelaunchInvite"("tokenHash");

CREATE INDEX "PrelaunchInvite_prelaunchSignupId_createdAt_idx"
  ON "PrelaunchInvite"("prelaunchSignupId", "createdAt");

CREATE INDEX "PrelaunchInvite_expectedEmail_expiresAt_idx"
  ON "PrelaunchInvite"("expectedEmail", "expiresAt");

ALTER TABLE "PrelaunchInvite"
  ADD CONSTRAINT "PrelaunchInvite_prelaunchSignupId_fkey"
  FOREIGN KEY ("prelaunchSignupId") REFERENCES "PrelaunchSignup"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
