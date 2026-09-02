import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";
import {
  SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG,
  SPOTIFY_DISCONNECT_REDACTED_TEXT,
} from "./spotify-disconnect-redaction";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6B preserves push delivery audit while redacting persisted provider-bearing text",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `gate6b-push-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-push-${suffix}`,
        access_token: "access-secret",
        refresh_token: "refresh-secret",
      },
    });

    const subscription = await prisma.pushSubscription.create({
      data: {
        userId: user.id,
        endpointHash: `hash-${suffix}`,
        endpoint: `https://push.example.test/${suffix}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
      },
    });
    const delivery = await prisma.pushDelivery.create({
      data: {
        userId: user.id,
        subscriptionId: subscription.id,
        eventKey: `cleanup-${suffix}`,
        category: "CLEANUP",
        payload: {
          title: "Limpeza concluída — Spotify Source Name",
          body: "1 música removida",
          url: "/dashboard/configuracao/limpeza",
          tag: `cleanup-${suffix}`,
        },
        status: "FAILED",
        attemptCount: 1,
        lastError: "provider source failed",
      },
    });

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(prepared.inventory.notificationDeliveryAudit, 1);

    const result = await executeSpotifyDisconnect(
      {
        userId: user.id,
        expectedFingerprint: prepared.fingerprint,
        confirmation: prepared.confirmationPhrase,
      },
      { client: prisma, lockTables: async () => {} },
    );

    assert.equal(result.afterInventory.notificationDeliveryAudit, 0);
    const preserved = await prisma.pushDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    assert.equal(preserved.status, "FAILED");
    assert.equal(preserved.attemptCount, 1);
    assert.equal(preserved.lastError, null);
    assert.deepEqual(preserved.payload, {
      title: SPOTIFY_DISCONNECT_REDACTED_TEXT,
      body: SPOTIFY_DISCONNECT_REDACTED_TEXT,
      url: "/dashboard",
      tag: SPOTIFY_DISCONNECT_REDACTED_NOTIFICATION_TAG,
    });
    assert.equal(
      await prisma.pushSubscription.count({ where: { id: subscription.id } }),
      1,
    );
  },
);
