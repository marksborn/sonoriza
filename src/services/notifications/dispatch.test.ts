import assert from "node:assert/strict";
import test from "node:test";

import { deliverOperationalNotification, retryDuePushDeliveries } from "./dispatch";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "./core";
import type {
  DeliveryAttempt,
  NotificationDeliveryStore,
  NotificationPreferencesShape,
  OperationalNotificationEvent,
  PushSubscriptionRecord,
} from "./types";

class MemoryStore implements NotificationDeliveryStore {
  preferences: NotificationPreferencesShape = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  };
  subscriptions: PushSubscriptionRecord[] = [
    {
      id: "sub-1",
      userId: "user-1",
      endpoint: "https://push.example/sub-1",
      p256dh: "p256dh",
      auth: "auth",
      expirationTime: null,
    },
  ];
  rows = new Map<
    string,
    DeliveryAttempt & { status: "PENDING" | "SENT" | "FAILED" | "STALE" | "SUPPRESSED" }
  >();
  staleSubscriptions = new Set<string>();

  async getPreferences() {
    return this.preferences;
  }

  async listActiveSubscriptions() {
    return this.subscriptions.filter(
      (subscription) => !this.staleSubscriptions.has(subscription.id),
    );
  }

  async claimEventDelivery(
    event: OperationalNotificationEvent,
    subscription: PushSubscriptionRecord,
  ) {
    const key = `${subscription.id}:${event.eventKey}`;
    const existing = this.rows.get(key);
    if (existing?.status === "SENT" || existing?.status === "STALE") return null;
    const attemptCount = (existing?.attemptCount ?? 0) + 1;
    const row = {
      id: key,
      userId: event.userId,
      eventKey: event.eventKey,
      category: event.category,
      payload: event.payload,
      attemptCount,
      subscription,
      status: "PENDING" as const,
    };
    this.rows.set(key, row);
    return row;
  }

  async markSent(delivery: DeliveryAttempt) {
    const row = this.find(delivery.id);
    row.status = "SENT";
  }

  async markStale(delivery: DeliveryAttempt) {
    const row = this.find(delivery.id);
    row.status = "STALE";
    this.staleSubscriptions.add(delivery.subscription.id);
  }

  async markFailed(delivery: DeliveryAttempt) {
    const row = this.find(delivery.id);
    row.status = "FAILED";
  }

  async listDueDeliveryIds() {
    return [...this.rows.values()]
      .filter((row) => row.status === "FAILED")
      .map((row) => row.id);
  }

  async claimExistingDelivery(id: string) {
    const row = this.find(id);
    if (row.status !== "FAILED") return null;
    row.status = "PENDING";
    row.attemptCount += 1;
    return row;
  }

  async suppressDelivery(id: string) {
    const row = this.find(id);
    row.status = "SUPPRESSED";
  }

  private find(id: string) {
    const row = [...this.rows.values()].find((candidate) => candidate.id === id);
    if (!row) throw new Error(`missing delivery ${id}`);
    return row;
  }
}

function event(category: OperationalNotificationEvent["category"] = "GENERATION") {
  return {
    userId: "user-1",
    eventKey: "generation:run-1",
    category,
    payload: {
      title: "Geração concluída",
      body: "8 itens · 6 músicas · 2 podcasts",
      url: "/dashboard",
      tag: "generation-run-1",
    },
  } satisfies OperationalNotificationEvent;
}

test("same event is sent once per subscription", async () => {
  const store = new MemoryStore();
  let sends = 0;
  const sender = async () => {
    sends += 1;
  };

  await deliverOperationalNotification(event(), { store, sender });
  await deliverOperationalNotification(event(), { store, sender });

  assert.equal(sends, 1);
  assert.equal([...store.rows.values()][0]?.status, "SENT");
});

test("NOOP does not create delivery while preference is disabled", async () => {
  const store = new MemoryStore();
  let sends = 0;

  const result = await deliverOperationalNotification(event("NOOP"), {
    store,
    sender: async () => {
      sends += 1;
    },
  });

  assert.equal(result.eligible, false);
  assert.equal(sends, 0);
  assert.equal(store.rows.size, 0);
});

test("410 marks subscription stale without throwing to caller", async () => {
  const store = new MemoryStore();
  const result = await deliverOperationalNotification(event(), {
    store,
    sender: async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    },
  });

  assert.equal(result.stale, 1);
  assert.equal(store.staleSubscriptions.has("sub-1"), true);
  assert.equal([...store.rows.values()][0]?.status, "STALE");
});

test("provider failure is isolated and succeeds on independent retry", async () => {
  const store = new MemoryStore();
  let firstAttempts = 0;
  const first = await deliverOperationalNotification(event(), {
    store,
    sender: async () => {
      firstAttempts += 1;
      throw Object.assign(new Error("temporary provider failure"), {
        statusCode: 503,
      });
    },
  });

  assert.equal(firstAttempts, 1);
  assert.equal(first.failed, 1);
  assert.equal([...store.rows.values()][0]?.status, "FAILED");

  let retrySends = 0;
  const retried = await retryDuePushDeliveries(10, {
    store,
    sender: async () => {
      retrySends += 1;
    },
  });

  assert.equal(retrySends, 1);
  assert.equal(retried.sent, 1);
  assert.equal([...store.rows.values()][0]?.status, "SENT");
});

test("preference changed before retry suppresses the queued push", async () => {
  const store = new MemoryStore();
  await deliverOperationalNotification(event(), {
    store,
    sender: async () => {
      throw Object.assign(new Error("temporary"), { statusCode: 503 });
    },
  });
  store.preferences.generationEnabled = false;

  const result = await retryDuePushDeliveries(10, {
    store,
    sender: async () => {
      throw new Error("should not send");
    },
  });

  assert.equal(result.skipped, 1);
  assert.equal([...store.rows.values()][0]?.status, "SUPPRESSED");
});
