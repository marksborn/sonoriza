-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('GENERATION', 'CLEANUP', 'ERROR', 'NOOP');

-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'STALE', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cleanupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "errorEnabled" BOOLEAN NOT NULL DEFAULT true,
    "noopEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointHash" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "expirationTime" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "lastFailureStatus" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushDelivery" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpointHash_key" ON "PushSubscription"("endpointHash");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_enabled_idx" ON "PushSubscription"("userId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PushDelivery_subscriptionId_eventKey_key" ON "PushDelivery"("subscriptionId", "eventKey");

-- CreateIndex
CREATE INDEX "PushDelivery_status_nextAttemptAt_idx" ON "PushDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "PushDelivery_userId_createdAt_idx" ON "PushDelivery"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushDelivery" ADD CONSTRAINT "PushDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
