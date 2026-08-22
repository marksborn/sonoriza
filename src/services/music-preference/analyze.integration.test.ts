import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { analyzeAndRecordInferredSkips, loadPendingInferredSkips } from "./analyze";
import { prismaMusicPreferenceSignalStore } from "./signal-store";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

const APPLIED = new Date("2026-08-14T05:00:00.000Z");

function at(minutes: number): Date {
  return new Date(APPLIED.getTime() + minutes * 60_000);
}

integrationTest(
  "analyzes the last applied generation, persists one skip, and consumes it once",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music05-${suffix}@example.test` },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const target = await prisma.targetPlaylist.create({
      data: { userId: user.id, name: "Carro", sequencePattern: ["MUSIC"] },
    });

    // A real, applied generation published A -> B -> C.
    const realRun = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        simulation: false,
        status: "SUCCESS",
        startedAt: APPLIED,
        finishedAt: APPLIED,
        items: {
          create: [
            { targetPlaylistId: target.id, position: 0, contentType: "MUSIC", spotifyUri: "spotify:track:A", spotifyTrackId: "A" },
            { targetPlaylistId: target.id, position: 1, contentType: "MUSIC", spotifyUri: "spotify:track:B", spotifyTrackId: "B" },
            { targetPlaylistId: target.id, position: 2, contentType: "MUSIC", spotifyUri: "spotify:track:C", spotifyTrackId: "C" },
          ],
        },
      },
    });

    // A newer simulation generation must not become the analysis source.
    await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        startedAt: at(120),
        finishedAt: at(120),
        items: {
          create: [
            { targetPlaylistId: target.id, position: 0, contentType: "MUSIC", spotifyUri: "spotify:track:A", spotifyTrackId: "A" },
          ],
        },
      },
    });

    // Observed plays: A then C, with a later unrelated play D as the edge so C
    // is not the inconclusive most-recent track. B was never played.
    await prisma.trackListeningEvent.createMany({
      data: [
        { userId: user.id, spotifyTrackId: "A", trackName: "A", artistName: "AA", playedAt: at(1), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `a-${suffix}` },
        { userId: user.id, spotifyTrackId: "C", trackName: "C", artistName: "CC", playedAt: at(2), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `c-${suffix}` },
        { userId: user.id, spotifyTrackId: "D", trackName: "D", artistName: "DD", playedAt: at(3), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `d-${suffix}` },
      ],
    });

    const analysis = await analyzeAndRecordInferredSkips(user.id, [target.id]);
    assert.equal(analysis.targets.length, 1);
    const targetResult = analysis.targets[0]!;
    assert.equal(targetResult.analyzedGenerationRunId, realRun.id);
    assert.equal(targetResult.inferredSkipCount, 1);
    assert.equal(targetResult.createdSignalCount, 1);

    let pending = await loadPendingInferredSkips(user.id, [target.id]);
    assert.deepEqual(
      (pending.get(target.id) ?? []).map((signal) => signal.spotifyTrackId),
      ["B"],
    );

    // Re-analyzing the same generation is idempotent (no duplicate signal).
    const reanalysis = await analyzeAndRecordInferredSkips(user.id, [target.id]);
    assert.equal(reanalysis.targets[0]!.createdSignalCount, 0);
    assert.equal(reanalysis.targets[0]!.duplicateSignalCount, 1);

    // Consuming marks it, removing it from pending; a second consume is a no-op.
    const signalId = (pending.get(target.id) ?? [])[0]!.id;
    const consumed = await prismaMusicPreferenceSignalStore.consume(
      user.id,
      [signalId],
      "consumer-run",
      at(200),
    );
    assert.equal(consumed, 1);

    pending = await loadPendingInferredSkips(user.id, [target.id]);
    assert.deepEqual(pending.get(target.id) ?? [], []);

    const again = await prismaMusicPreferenceSignalStore.consume(
      user.id,
      [signalId],
      "consumer-run-2",
      at(300),
    );
    assert.equal(again, 0);
  },
);

integrationTest(
  "previews a newly inferable skip for planning without persisting it",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music05-preview-${suffix}@example.test` },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const target = await prisma.targetPlaylist.create({
      data: { userId: user.id, name: "Avulsa", sequencePattern: ["MUSIC"] },
    });

    const realRun = await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "MANUAL",
        simulation: false,
        status: "SUCCESS",
        startedAt: APPLIED,
        finishedAt: APPLIED,
        items: {
          create: [
            { targetPlaylistId: target.id, position: 14, contentType: "MUSIC", spotifyUri: "spotify:track:A", spotifyTrackId: "A" },
            { targetPlaylistId: target.id, position: 15, contentType: "MUSIC", spotifyUri: "spotify:track:B", spotifyTrackId: "B" },
            { targetPlaylistId: target.id, position: 16, contentType: "MUSIC", spotifyUri: "spotify:track:C", spotifyTrackId: "C" },
          ],
        },
      },
    });

    await prisma.trackListeningEvent.createMany({
      data: [
        { userId: user.id, spotifyTrackId: "A", trackName: "A", artistName: "AA", playedAt: at(1), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `preview-a-${suffix}` },
        { userId: user.id, spotifyTrackId: "C", trackName: "C", artistName: "CC", playedAt: at(2), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `preview-c-${suffix}` },
        { userId: user.id, spotifyTrackId: "D", trackName: "D", artistName: "DD", playedAt: at(3), source: "SPOTIFY_RECENTLY_PLAYED", sourceEventKey: `preview-d-${suffix}` },
      ],
    });

    assert.equal(
      await prisma.musicPreferenceSignal.count({ where: { userId: user.id } }),
      0,
    );

    const preview = await loadPendingInferredSkips(user.id, [target.id]);
    const previewSignals = preview.get(target.id) ?? [];
    assert.equal(previewSignals.length, 1);
    assert.equal(previewSignals[0]!.spotifyTrackId, "B");
    assert.equal(previewSignals[0]!.sourceGenerationRunId, realRun.id);
    assert.equal(previewSignals[0]!.position, 15);
    assert.match(previewSignals[0]!.id, /^preview:/);

    // Read-only planning parity must not persist the would-be signal.
    assert.equal(
      await prisma.musicPreferenceSignal.count({ where: { userId: user.id } }),
      0,
    );

    // A real analysis persists the same inference once, after which pending uses
    // the canonical DB-backed signal instead of the synthetic preview identity.
    const analysis = await analyzeAndRecordInferredSkips(user.id, [target.id]);
    assert.equal(analysis.targets[0]!.createdSignalCount, 1);

    const pending = await loadPendingInferredSkips(user.id, [target.id]);
    const persistedSignals = pending.get(target.id) ?? [];
    assert.equal(persistedSignals.length, 1);
    assert.equal(persistedSignals[0]!.spotifyTrackId, "B");
    assert.equal(persistedSignals[0]!.position, 15);
    assert.doesNotMatch(persistedSignals[0]!.id, /^preview:/);
  },
);

integrationTest(
  "records nothing when there is no prior applied generation",
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `music05-empty-${suffix}@example.test` },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const target = await prisma.targetPlaylist.create({
      data: { userId: user.id, name: "Casa", sequencePattern: ["MUSIC"] },
    });

    const analysis = await analyzeAndRecordInferredSkips(user.id, [target.id]);
    assert.equal(analysis.targets[0]!.reason, "NO_APPLIED_GENERATION");
    assert.equal(analysis.targets[0]!.createdSignalCount, 0);
  },
);
