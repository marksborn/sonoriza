import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";
import { SPOTIFY_DISCONNECT_REDACTED_URI } from "./spotify-disconnect-redaction";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6B clears unprovenanced OAuth profile fields and provider duration metadata while preserving account identity",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `gate6b-profile-${suffix}@example.test`;
    const user = await prisma.user.create({
      data: {
        email,
        name: "Provider Profile Name",
        image: "https://example.test/provider-avatar.png",
      },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-profile-${suffix}`,
        access_token: "access-secret",
        refresh_token: "refresh-secret",
      },
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: "Preserved Target",
        spotifyPlaylistId: `target-${suffix}`,
        sequencePattern: [],
      },
    });
    const run = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        status: "SUCCESS",
      },
    });
    await prisma.generationItem.create({
      data: {
        runId: run.id,
        targetPlaylistId: target.id,
        position: 1,
        contentType: "MUSIC",
        spotifyUri: "spotify:track:provider-duration",
        durationMs: 245_000,
      },
    });

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);
    assert.equal(prepared.inventory.userProfileProviderFields, 1);
    assert.equal(prepared.inventory.generationAuditWithProviderFields, 1);

    const result = await executeSpotifyDisconnect(
      {
        userId: user.id,
        expectedFingerprint: prepared.fingerprint,
        confirmation: prepared.confirmationPhrase,
      },
      { client: prisma, lockTables: async () => {} },
    );

    assert.equal(result.afterInventory.userProfileProviderFields, 0);
    assert.equal(result.afterInventory.generationAuditWithProviderFields, 0);
    assert.equal(result.afterInventory.oauthAccount, 0);

    const preservedUser = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    assert.equal(preservedUser.email, email);
    assert.equal(preservedUser.name, null);
    assert.equal(preservedUser.image, null);

    const preservedTarget = await prisma.targetPlaylist.findUniqueOrThrow({
      where: { id: target.id },
    });
    assert.equal(preservedTarget.spotifyPlaylistId, `target-${suffix}`);

    const redactedItem = await prisma.generationItem.findFirstOrThrow({
      where: { runId: run.id },
    });
    assert.equal(redactedItem.spotifyUri, SPOTIFY_DISCONNECT_REDACTED_URI);
    assert.equal(redactedItem.durationMs, 0);
  },
);
