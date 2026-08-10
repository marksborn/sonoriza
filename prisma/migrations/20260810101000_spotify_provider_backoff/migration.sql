CREATE TABLE "ProviderBackoff" (
    "provider" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operation" TEXT,
    "retryAfterSeconds" INTEGER,
    "blockedUntil" TIMESTAMP(3) NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderBackoff_pkey" PRIMARY KEY ("provider")
);

CREATE INDEX "ProviderBackoff_blockedUntil_idx"
ON "ProviderBackoff"("blockedUntil");
