import assert from "node:assert/strict";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { PrismaSpotifyDisconnectInventoryStore } from "./spotify-disconnect-prisma-inventory";

const prisma = new PrismaClient();

test("Gate 6A inventory separates Spotify, mixed Last.fm and unrelated provider state", async (t) => {
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: {
      email: `gate6a-${nonce}@example.test`,
      name: "Gate 6A synthetic",
    },
    select: { id: true },
  });

  t.after(async () => {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  });

  await prisma.account.createMany({
    data: [
      {
        userId: user.id,
        type: "oauth",
        provider: "spotify",
        providerAccountId: `spotify-${nonce}`,
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
      },
      {
        userId: user.id,
        type: "oauth",
        provider: "google",
        providerAccountId: `google-${nonce}`,
        access_token: "synthetic-google-access",
      },
    ],
  });

  await prisma.calendarSelection.create({
    data: {
      userId: user.id,
      googleCalendarId: `calendar-${nonce}`,
      summary: "Synthetic calendar",
    },
  });

  await prisma.lastFmBackfillRun.create({
    data: {
      userId: user.id,
      username: `lastfm-${nonce}`,
      to: new Date(),
    },
  });

  await prisma.trackListeningEvent.createMany({
    data: [
      {
        userId: user.id,
        trackName: "Pure Last.fm",
        artistName: "Synthetic Artist",
        playedAt: new Date("2026-09-01T10:00:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `lastfm-pure-${nonce}`,
      },
      {
        userId: user.id,
        spotifyTrackId: `spotify-track-${nonce}`,
        spotifyUri: `spotify:track:${nonce}`,
        trackName: "Mixed Last.fm",
        artistName: "Synthetic Artist",
        playedAt: new Date("2026-09-01T10:05:00.000Z"),
        source: "LASTFM_SCROBBLE",
        sourceEventKey: `lastfm-mixed-${nonce}`,
        metadata: {
          spotifyExtendedHistory: {
            synthetic: true,
          },
        },
      },
      {
        userId: user.id,
        spotifyTrackId: `spotify-recent-${nonce}`,
        spotifyUri: `spotify:track:recent-${nonce}`,
        trackName: "Spotify Recent",
        artistName: "Synthetic Artist",
        playedAt: new Date("2026-09-01T10:10:00.000Z"),
        source: "SPOTIFY_RECENTLY_PLAYED",
        sourceEventKey: `spotify-recent-${nonce}`,
      },
    ],
  });

  const inventory = await new PrismaSpotifyDisconnectInventoryStore(prisma).load(
    user.id,
  );

  assert.equal(inventory.oauthAccount, 1);
  assert.equal(inventory.unrelatedOauthAccount, 1);
  assert.equal(inventory.googleCalendarSelection, 1);
  assert.equal(inventory.spotifyListeningEvent, 1);
  assert.equal(inventory.mixedListeningEvent, 1);
  assert.equal(inventory.pureLastFmListeningEvent, 1);
  assert.equal(inventory.lastFmBackfillRun, 1);
  assert.equal(inventory.userAccount, 1);
});

test.after(async () => {
  await prisma.$disconnect();
});
