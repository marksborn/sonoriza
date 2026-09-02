import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import {
  SPOTIFY_DISCONNECT_ERROR_CODES,
  SpotifyDisconnectError,
  executeSpotifyDisconnect,
  prepareSpotifyDisconnect,
} from "./spotify-disconnect-executor";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "Gate 6B rejects a stale preview before deleting credentials or newly-created configuration",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `gate6b-stale-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });

    await prisma.account.create({
      data: {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-stale-${suffix}`,
        access_token: "access-secret",
        refresh_token: "refresh-secret",
      },
    });

    const prepared = await prepareSpotifyDisconnect(user.id, prisma);

    const source = await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "MUSIC",
        spotifyType: "PLAYLIST",
        spotifyId: `created-after-preview-${suffix}`,
        name: "Created after preview",
      },
    });

    await assert.rejects(
      executeSpotifyDisconnect(
        {
          userId: user.id,
          expectedFingerprint: prepared.fingerprint,
          confirmation: prepared.confirmationPhrase,
        },
        { client: prisma, lockTables: async () => {} },
      ),
      (error) =>
        error instanceof SpotifyDisconnectError &&
        error.code === SPOTIFY_DISCONNECT_ERROR_CODES.PREVIEW_CHANGED,
    );

    assert.equal(
      await prisma.account.count({
        where: { userId: user.id, provider: "spotify" },
      }),
      1,
    );
    const untouchedSource = await prisma.sourcePlaylist.findUniqueOrThrow({
      where: { id: source.id },
    });
    assert.equal(untouchedSource.name, "Created after preview");
  },
);
