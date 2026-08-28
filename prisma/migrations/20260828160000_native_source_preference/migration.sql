-- SOURCE-LIKED-01 Gate 5B1
-- Provider-neutral, opt-in user preference for native Sonoriza sources.
-- No existing user is enabled by this migration.

CREATE TYPE "NativeSourceType" AS ENUM ('LIKED_TRACKS');

CREATE TABLE "NativeSourcePreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NativeSourceType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NativeSourcePreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NativeSourcePreference_userId_type_key"
ON "NativeSourcePreference"("userId", "type");

CREATE INDEX "NativeSourcePreference_userId_enabled_idx"
ON "NativeSourcePreference"("userId", "enabled");

ALTER TABLE "NativeSourcePreference"
ADD CONSTRAINT "NativeSourcePreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
