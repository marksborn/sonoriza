import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";

import { generatePlaylists } from "./generate-playlists";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;

integrationTest(
  "#435 GenerationRun is observable as RUNNING in the creation hook and is terminalized if the hook fails",
  { concurrency: false },
  async (t) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `generation-lifecycle-${suffix}@example.test` },
    });

    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let observedRunId: string | null = null;

    globalThis.fetch = (async () => {
      providerCalls += 1;
      throw new Error("provider must not be reached before #435 lifecycle hook");
    }) as typeof fetch;

    try {
      const result = await generatePlaylists({
        userId: user.id,
        trigger: "SIMULATION",
        simulate: true,
        onGenerationRunCreated: async (runId) => {
          observedRunId = runId;
          const running = await prisma.generationRun.findUniqueOrThrow({
            where: { id: runId },
            select: { status: true, finishedAt: true, error: true },
          });

          assert.equal(running.status, "RUNNING");
          assert.equal(running.finishedAt, null);
          assert.equal(running.error, null);
          assert.equal(providerCalls, 0);

          throw new Error("#435 lifecycle hook failure");
        },
      });

      assert.ok(observedRunId);
      assert.equal(result.runId, observedRunId);
      assert.equal(result.status, "FAILED");
      assert.equal(providerCalls, 0);

      const finished = await prisma.generationRun.findUniqueOrThrow({
        where: { id: result.runId },
        select: { status: true, finishedAt: true, error: true },
      });
      assert.equal(finished.status, "FAILED");
      assert.ok(finished.finishedAt instanceof Date);
      assert.match(finished.error ?? "", /#435 lifecycle hook failure/);

      const itemCount = await prisma.generationItem.count({
        where: { runId: result.runId },
      });
      assert.equal(itemCount, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);
