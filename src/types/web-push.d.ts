declare module "web-push" {
  export type WebPushSubscription = {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  };

  export type WebPushRequestOptions = {
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    topic?: string;
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
  };

  export function sendNotification(
    subscription: WebPushSubscription,
    payload?: string,
    options?: WebPushRequestOptions,
  ): Promise<{ statusCode?: number }>;
}
