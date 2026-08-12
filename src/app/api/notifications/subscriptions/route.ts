import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import {
  countActivePushSubscriptions,
  disablePushSubscription,
  PushSubscriptionOwnershipError,
  savePushSubscription,
} from "@/services/notifications";
import { getWebPushPublicConfiguration } from "@/services/notifications/web-push";

export const dynamic = "force-dynamic";

const endpointSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => value.startsWith("https://"), "Push endpoint deve usar HTTPS");

const subscriptionSchema = z.object({
  endpoint: endpointSchema,
  expirationTime: z.number().finite().nonnegative().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(20).max(1024),
    auth: z.string().min(8).max(512),
  }),
});

const deleteSchema = z.object({ endpoint: endpointSchema });

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [activeDeviceCount, webPush] = await Promise.all([
    countActivePushSubscriptions(session.user.id),
    Promise.resolve(getWebPushPublicConfiguration()),
  ]);
  return NextResponse.json({
    activeDeviceCount,
    configured: webPush.configured,
    publicKey: webPush.publicKey,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!getWebPushPublicConfiguration().configured) {
    return NextResponse.json(
      { error: "Web Push ainda não está configurado no servidor." },
      { status: 503 },
    );
  }

  const parsed = subscriptionSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Subscription inválida." }, { status: 400 });
  }

  try {
    await savePushSubscription(session.user.id, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      expirationTime:
        typeof parsed.data.expirationTime === "number" && parsed.data.expirationTime > 0
          ? new Date(parsed.data.expirationTime)
          : null,
    });
    return NextResponse.json(
      { activeDeviceCount: await countActivePushSubscriptions(session.user.id) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof PushSubscriptionOwnershipError) {
      return NextResponse.json(
        { error: error.message, code: "SUBSCRIPTION_OWNERSHIP_CONFLICT" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Não foi possível registrar as notificações neste dispositivo." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = deleteSchema.safeParse(await safeJson(request));
  if (!parsed.success) {
    return NextResponse.json({ error: "Subscription inválida." }, { status: 400 });
  }

  await disablePushSubscription(session.user.id, parsed.data.endpoint);
  return NextResponse.json({
    activeDeviceCount: await countActivePushSubscriptions(session.user.id),
  });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
