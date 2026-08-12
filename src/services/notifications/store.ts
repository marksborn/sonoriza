import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DELIVERY_CLAIM_TIMEOUT_MS,
  MAX_PUSH_ATTEMPTS,
  hashPushEndpoint,
  retryDelayMs,
} from "./core";
import type {
  DeliveryAttempt,
  NotificationDeliveryStore,
  NotificationPreferencesShape,
  OperationalNotificationEvent,
  OperationalPushPayload,
  PushSubscriptionRecord,
} from "./types";

export class PushSubscriptionOwnershipError extends Error {}

function parsePayload(value: unknown): OperationalPushPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.title !== "string" ||
    typeof data.body !== "string" ||
    typeof data.url !== "string" ||
    typeof data.tag !== "string"
  ) {
    return null;
  }
  return {
    title: data.title,
    body: data.body,
    url: data.url,
    tag: data.tag,
  };
}

function subscriptionRecord(value: {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
}): PushSubscriptionRecord {
  return value;
}

export async function getNotificationPreferences(
  userId: string,
): Promise<NotificationPreferencesShape> {
  const preference = await prisma.notificationPreference.findUnique({
    where: { userId },
  });
  if (!preference) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  return {
    generationEnabled: preference.generationEnabled,
    cleanupEnabled: preference.cleanupEnabled,
    errorEnabled: preference.errorEnabled,
    noopEnabled: preference.noopEnabled,
  };
}

export async function saveNotificationPreferences(
  userId: string,
  preferences: NotificationPreferencesShape,
): Promise<NotificationPreferencesShape> {
  const saved = await prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId, ...preferences },
    update: preferences,
  });
  return {
    generationEnabled: saved.generationEnabled,
    cleanupEnabled: saved.cleanupEnabled,
    errorEnabled: saved.errorEnabled,
    noopEnabled: saved.noopEnabled,
  };
}

export async function countActivePushSubscriptions(userId: string): Promise<number> {
  return prisma.pushSubscription.count({ where: { userId, enabled: true } });
}

export async function savePushSubscription(
  userId: string,
  input: {
    endpoint: string;
    p256dh: string;
    auth: string;
    expirationTime?: Date | null;
  },
): Promise<{ id: string }> {
  const endpointHash = hashPushEndpoint(input.endpoint);
  const existing = await prisma.pushSubscription.findUnique({
    where: { endpointHash },
    select: { id: true, userId: true },
  });

  if (existing && existing.userId !== userId) {
    throw new PushSubscriptionOwnershipError(
      "Esta subscription pertence a outra sessão. Remova a inscrição local e ative novamente.",
    );
  }

  if (existing) {
    return prisma.pushSubscription.update({
      where: { id: existing.id },
      data: {
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        expirationTime: input.expirationTime ?? null,
        enabled: true,
        lastFailureAt: null,
        lastFailureStatus: null,
      },
      select: { id: true },
    });
  }

  return prisma.pushSubscription.create({
    data: {
      userId,
      endpointHash,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      expirationTime: input.expirationTime ?? null,
    },
    select: { id: true },
  });
}

export async function disablePushSubscription(
  userId: string,
  endpoint: string,
): Promise<boolean> {
  const result = await prisma.pushSubscription.updateMany({
    where: { userId, endpointHash: hashPushEndpoint(endpoint), enabled: true },
    data: { enabled: false },
  });
  return result.count > 0;
}

export class PrismaNotificationDeliveryStore implements NotificationDeliveryStore {
  async getPreferences(userId: string) {
    return getNotificationPreferences(userId);
  }

  async listActiveSubscriptions(userId: string): Promise<PushSubscriptionRecord[]> {
    const rows = await prisma.pushSubscription.findMany({
      where: { userId, enabled: true },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        endpoint: true,
        p256dh: true,
        auth: true,
        expirationTime: true,
      },
    });
    return rows.map(subscriptionRecord);
  }

  async claimEventDelivery(
    event: OperationalNotificationEvent,
    subscription: PushSubscriptionRecord,
    now: Date,
  ): Promise<DeliveryAttempt | null> {
    const row = await prisma.pushDelivery.upsert({
      where: {
        subscriptionId_eventKey: {
          subscriptionId: subscription.id,
          eventKey: event.eventKey,
        },
      },
      create: {
        userId: event.userId,
        subscriptionId: subscription.id,
        eventKey: event.eventKey,
        category: event.category,
        payload: event.payload as Prisma.InputJsonValue,
      },
      update: {},
    });
    return this.claimRow(row.id, now);
  }

  async markSent(delivery: DeliveryAttempt, now: Date): Promise<void> {
    await prisma.$transaction([
      prisma.pushDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          sentAt: now,
          nextAttemptAt: null,
          lastError: null,
        },
      }),
      prisma.pushSubscription.update({
        where: { id: delivery.subscription.id },
        data: {
          lastSuccessAt: now,
          lastFailureAt: null,
          lastFailureStatus: null,
        },
      }),
    ]);
  }

  async markStale(
    delivery: DeliveryAttempt,
    statusCode: number | null,
    now: Date,
  ): Promise<void> {
    await prisma.$transaction([
      prisma.pushDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "STALE",
          nextAttemptAt: null,
          lastError: statusCode ? `Push endpoint expirado (${statusCode})` : "Push endpoint expirado",
        },
      }),
      prisma.pushSubscription.update({
        where: { id: delivery.subscription.id },
        data: {
          enabled: false,
          lastFailureAt: now,
          lastFailureStatus: statusCode,
        },
      }),
    ]);
  }

  async markFailed(
    delivery: DeliveryAttempt,
    statusCode: number | null,
    message: string,
    now: Date,
  ): Promise<void> {
    const exhausted = delivery.attemptCount >= MAX_PUSH_ATTEMPTS;
    await prisma.$transaction([
      prisma.pushDelivery.update({
        where: { id: delivery.id },
        data: {
          status: exhausted ? "SUPPRESSED" : "FAILED",
          nextAttemptAt: exhausted
            ? null
            : new Date(now.getTime() + retryDelayMs(delivery.attemptCount)),
          lastError: message,
        },
      }),
      prisma.pushSubscription.update({
        where: { id: delivery.subscription.id },
        data: {
          lastFailureAt: now,
          lastFailureStatus: statusCode,
        },
      }),
    ]);
  }

  async listDueDeliveryIds(now: Date, limit: number): Promise<string[]> {
    const rows = await prisma.pushDelivery.findMany({
      where: {
        status: "FAILED",
        attemptCount: { lt: MAX_PUSH_ATTEMPTS },
        nextAttemptAt: { lte: now },
        subscription: { enabled: true },
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async claimExistingDelivery(id: string, now: Date): Promise<DeliveryAttempt | null> {
    return this.claimRow(id, now);
  }

  async suppressDelivery(id: string, reason: string): Promise<void> {
    await prisma.pushDelivery.updateMany({
      where: { id, status: { in: ["PENDING", "FAILED"] } },
      data: { status: "SUPPRESSED", nextAttemptAt: null, lastError: reason },
    });
  }

  private async claimRow(id: string, now: Date): Promise<DeliveryAttempt | null> {
    const current = await prisma.pushDelivery.findUnique({
      where: { id },
      include: {
        subscription: {
          select: {
            id: true,
            userId: true,
            endpoint: true,
            p256dh: true,
            auth: true,
            expirationTime: true,
            enabled: true,
          },
        },
      },
    });
    if (!current || !current.subscription.enabled) return null;
    if (["SENT", "STALE", "SUPPRESSED"].includes(current.status)) return null;
    if (current.attemptCount >= MAX_PUSH_ATTEMPTS) return null;
    if (
      current.status === "FAILED" &&
      current.nextAttemptAt &&
      current.nextAttemptAt.getTime() > now.getTime()
    ) {
      return null;
    }
    if (
      current.status === "PENDING" &&
      current.lastAttemptAt &&
      now.getTime() - current.lastAttemptAt.getTime() < DELIVERY_CLAIM_TIMEOUT_MS
    ) {
      return null;
    }

    const claimed = await prisma.pushDelivery.updateMany({
      where: {
        id: current.id,
        status: current.status,
        attemptCount: current.attemptCount,
        updatedAt: current.updatedAt,
      },
      data: {
        status: "PENDING",
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        nextAttemptAt: null,
      },
    });
    if (claimed.count !== 1) return null;

    const payload = parsePayload(current.payload);
    if (!payload) {
      await this.suppressDelivery(current.id, "Payload de push inválido", now);
      return null;
    }

    return {
      id: current.id,
      userId: current.userId,
      eventKey: current.eventKey,
      category: current.category,
      payload,
      attemptCount: current.attemptCount + 1,
      subscription: subscriptionRecord(current.subscription),
    };
  }
}
