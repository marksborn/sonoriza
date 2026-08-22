import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import { loadPendingInferredSkips } from "@/services/music-preference";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;
const APPLIED = new Date("2026-08-22T10:00:00.000Z");

function at(minutes: number): Date {
  return new Date(APPLIED.getTime() + minutes * 60_000);
}

integrationTest(
  "Gate 5H simulation sees a currently inferable MUSIC-05 skip without persisting it",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `discovery-music05-parity-${suffix}@example.test` },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const target = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: "Avulsa",
        musicOrderMode: "RANDOMIZED",
        compositionMode: "SEQUENCE",
        sequencePattern: ["MUSIC"],
      },
    });

    const appliedRun = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        simulation: false,
        status: "SUCCESS",
        startedAt: APPLIED,
        finishedAt: APPLIED,
        items: {
          create: [
            {
              targetPlaylistId: target.id,
              position: 14,
              contentType: "MUSIC",
              spotifyUri: "spotify:track:previous",
              spotifyTrackId: "previous",
            },
            {
              targetPlaylistId: target.id,
              position: 15,
              contentType: "MUSIC",
              spotifyUri: "spotify:track:skipped",
              spotifyTrackId: "skipped",
            },
            {
              targetPlaylistId: target.id,
              position: 16,
              contentType: "MUSIC",
              spotifyUri: "spotify:track:next",
              spotifyTrackId: "next",
            },
          ],
        },
      },
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        {
          userId: user.id,
          spotifyTrackId: "previous",
          trackName: "Previous",
          artistName: "Artist",
          playedAt: at(1),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `previous-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "next",
          trackName: "Next",
          artistName: "Artist",
          playedAt: at(2),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `next-${suffix}`,
        },
        {
          userId: user.id,
          spotifyTrackId: "edge",
          trackName: "Edge",
          artistName: "Artist",
          playedAt: at(3),
          source: "SPOTIFY_RECENTLY_PLAYED",
          sourceEventKey: `edge-${suffix}`,
        },
      ],
    });

    const before = await prisma.musicPreferenceSignal.count({
      where: { userId: user.id },
    });
    assert.equal(before, 0);

    const pending = await loadPendingInferredSkips(user.id, [target.id]);
    const signals = pending.get(target.id) ?? [];

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.spotifyTrackId, "skipped");
    assert.equal(signals[0]!.sourceGenerationRunId, appliedRun.id);
    assert.equal(signals[0]!.position, 15);
    assert.match(signals[0]!.id, /^preview:/);

    const after = await prisma.musicPreferenceSignal.count({
      where: { userId: user.id },
    });
    assert.equal(after, 0);
  },
);
