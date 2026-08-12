export type NotificationCategoryValue =
  | "GENERATION"
  | "CLEANUP"
  | "ERROR"
  | "NOOP";

export type NotificationPreferencesShape = {
  generationEnabled: boolean;
  cleanupEnabled: boolean;
  errorEnabled: boolean;
  noopEnabled: boolean;
};

export type OperationalPushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

export type OperationalNotificationEvent = {
  userId: string;
  eventKey: string;
  category: NotificationCategoryValue;
  payload: OperationalPushPayload;
};

export type PushSubscriptionRecord = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
};

export type DeliveryAttempt = {
  id: string;
  userId: string;
  eventKey: string;
  category: NotificationCategoryValue;
  payload: OperationalPushPayload;
  attemptCount: number;
  subscription: PushSubscriptionRecord;
};

export type PushSendResult = {
  statusCode?: number;
};

export type PushSender = (
  subscription: PushSubscriptionRecord,
  payload: OperationalPushPayload,
  eventKey: string,
) => Promise<PushSendResult | void>;

export type NotificationDeliveryStore = {
  getPreferences(userId: string): Promise<NotificationPreferencesShape>;
  listActiveSubscriptions(userId: string): Promise<PushSubscriptionRecord[]>;
  claimEventDelivery(
    event: OperationalNotificationEvent,
    subscription: PushSubscriptionRecord,
    now: Date,
  ): Promise<DeliveryAttempt | null>;
  markSent(delivery: DeliveryAttempt, now: Date): Promise<void>;
  markStale(
    delivery: DeliveryAttempt,
    statusCode: number | null,
    now: Date,
  ): Promise<void>;
  markFailed(
    delivery: DeliveryAttempt,
    statusCode: number | null,
    message: string,
    now: Date,
  ): Promise<void>;
  listDueDeliveryIds(now: Date, limit: number): Promise<string[]>;
  claimExistingDelivery(id: string, now: Date): Promise<DeliveryAttempt | null>;
  suppressDelivery(id: string, reason: string, now: Date): Promise<void>;
};
