import { sendNotification } from "web-push";

import { notificationTopic, normalizePushPayload } from "./core";
import type { PushSender } from "./types";

export type WebPushPublicConfiguration = {
  configured: boolean;
  publicKey: string | null;
};

type WebPushConfiguration = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

function readWebPushConfiguration(): WebPushConfiguration | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim() ?? "";
  if (!publicKey || !privateKey || !subject) return null;
  return { subject, publicKey, privateKey };
}

export function getWebPushPublicConfiguration(): WebPushPublicConfiguration {
  const config = readWebPushConfiguration();
  return {
    configured: Boolean(config),
    publicKey: config?.publicKey ?? null,
  };
}

export const sendOperationalWebPush: PushSender = async (
  subscription,
  payload,
  eventKey,
) => {
  const config = readWebPushConfiguration();
  if (!config) {
    throw new Error("Web Push não configurado no servidor");
  }

  const safePayload = normalizePushPayload(payload);
  const response = await sendNotification(
    {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime?.getTime() ?? null,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    },
    JSON.stringify(safePayload),
    {
      TTL: 60 * 60,
      urgency: safePayload.title.toLowerCase().includes("falhou") ? "high" : "normal",
      topic: notificationTopic(eventKey),
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
    },
  );

  return { statusCode: response.statusCode };
};
