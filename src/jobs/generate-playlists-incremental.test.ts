import assert from "node:assert/strict";
import test from "node:test";

import { prisma } from "@/lib/prisma";
import {
  getFirstRunGate,
  type ConfigurationAssessment,
} from "@/services/configuration-readiness";

import { generatePlaylists } from "./generate-playlists";

const integrationTest = process.env.DATABASE_URL ? test : test.skip;
const SECRET_TOKEN = "spotify-test-token-never-log";

type RunSummary = {
  inconclusive: boolean;
  inconclusiveReason?: string;
  qualityPassed: boolean;
  qualityFailures: unknown[];
  incrementalCollection: {
    podcastCandidatesRead: number;
  };
  sourceCollection: {
    unavailableSourceCount: number;
    readSourceCount: number;
    planningRounds: number;
  };
  spotifyApi: {
    rateLimitedCount: number;
    retries: number;
    retryWaitMs: number;
    totalCalls: number;
    sourceReads: Record<string, { pagesRead: number }>;
  };
  targets: unknown[];
};

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function episode(uri: string, programId: string, durationMs = 300_000) {
  return {
    item: {
      uri,
      name: uri,
      duration_ms: durationMs,
      type: "episode",
      is_local: false,
      is_playable: true,
      show: { id: programId, name: programId },
      resume_point: { fully_played: false, resume_position_ms: 0 },
    },
  };
}

async function createFixture(input: { sources?: number; targets?: number } = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const user = await prisma.user.create({
    data: { email: `spotify-orchestration-${suffix}@example.test` },
  });

  await prisma.account.create({
    data: {
      userId: user.id,
      type: "oauth",
      provider: "spotify",
      providerAccountId: `spotify-${suffix}`,
      access_token: SECRET_TOKEN,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: "user-library-read user-read-playback-position",
    },
  });

  for (let index = 0; index < (input.sources ?? 1); index += 1) {
    await prisma.sourcePlaylist.create({
      data: {
        userId: user.id,
        kind: "PODCAST",
        spotifyType: "PLAYLIST",
        spotifyId: `playlist-source-${index}-${suffix}`,
        name: `Podcast source ${index + 1}`,
      },
    });
  }

  for (let index = 0; index < (input.targets ?? 1); index += 1) {
    await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: `Target ${index + 1}`,
        spotifyPlaylistId: `playlist-target-${index}-${suffix}`,
        priority: index,
        durationMode: "FIXED",
        fixedDurationSeconds: 300,
        podcastPercent: 100,
        sequencePattern: ["PODCAST"],
        maxEpisodesPerProgram: 10,
      },
    });
  }

  return user;
}

async function readRun(runId: string) {
  return prisma.generationRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      status: true,
      error: true,
      summary: true,
      logs: {
        orderBy: { createdAt: "asc" },
        select: { level: true, message: true, data: true },
      },
    },
  });
}

function summaryObject(summary: unknown): RunSummary {
  assert.ok(summary && typeof summary === "object" && !Array.isArray(summary));
  return summary as unknown as RunSummary;
}

integrationTest(
  "recovered Retry-After continues the simulation and persists auditable wait metrics",
  { concurrency: false },
  async (t) => {
    const user = await createFixture();
    t.after(async () => {
      // This case deliberately replaces setTimeout with an immediate callback,
      // so wall-clock time does not actually advance by the mocked 2 seconds.
      // Clear only this test's persisted provider backoff before later cases;
      // production uses the real timer, by which point the same window expires.
      await prisma.$executeRawUnsafe('DELETE FROM "ProviderBackoff" WHERE "provider" = \'spotify\'');
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    const originalRandom = Math.random;
    const originalSetTimeout = globalThis.setTimeout;
    let calls = 0;
    const waits: number[] = [];

    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { error: { status: 429, message: "Too many requests" } },
          { status: 429, headers: { "Retry-After": "2" } },
        );
      }
      return jsonResponse({
        items: [episode("spotify:episode:recovered", "show-recovered")],
        next: null,
      });
    }) as typeof fetch;
    Math.random = () => 0;
    globalThis.setTimeout = ((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      waits.push(Number(delay ?? 0));
      callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const result = await generatePlaylists({
        userId: user.id,
        trigger: "SIMULATION",
        simulate: true,
      });
      assert.equal(result.status, "SUCCESS");
      assert.equal(calls, 2);
      assert.deepEqual(waits, [2000]);

      const run = await readRun(result.runId);
      const summary = summaryObject(run.summary);
      assert.equal(summary.inconclusive, false);
      assert.equal(summary.qualityPassed, true);
      assert.equal(summary.spotifyApi.rateLimitedCount, 1);
      assert.equal(summary.spotifyApi.retries, 1);
      assert.equal(summary.spotifyApi.retryWaitMs, 2000);
      assert.equal(summary.spotifyApi.totalCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      Math.random = originalRandom;
      globalThis.setTimeout = originalSetTimeout;
    }
  },
);

integrationTest(
  "newest inconclusive simulation overrides an older success and never turns a partial pool into mix failure",
  { concurrency: false },
  async (t) => {
    const user = await createFixture({ sources: 2 });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    await prisma.generationRun.create({
      data: {
        userId: user.id,
        trigger: "SIMULATION",
        simulation: true,
        status: "SUCCESS",
        startedAt: new Date(Date.now() - 60_000),
        finishedAt: new Date(Date.now() - 59_000),
        summary: {
          configurationFingerprint: "fingerprint-test",
          qualityPassed: true,
          inconclusive: false,
        },
      },
    });

    const originalFetch = globalThis.fetch;
    const originalRandom = Math.random;
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          items: [episode("spotify:episode:known-partial", "show-partial")],
          next: null,
        });
      }
      return jsonResponse(
        {
          error: {
            status: 429,
            message: `Authorization: Bearer ${SECRET_TOKEN}`,
          },
        },
        { status: 429, headers: { "Retry-After": "0" } },
      );
    }) as typeof fetch;
    Math.random = () => 0;

    try {
      const result = await generatePlaylists({
        userId: user.id,
        trigger: "SIMULATION",
        simulate: true,
      });
      assert.equal(result.status, "FAILED");
      assert.equal(calls, 3);

      const run = await readRun(result.runId);
      const summary = summaryObject(run.summary);
      assert.equal(summary.inconclusive, true);
      assert.equal(summary.inconclusiveReason, "RATE_LIMITED");
      assert.equal(summary.qualityPassed, false);
      assert.deepEqual(summary.qualityFailures, []);
      assert.equal(summary.incrementalCollection.podcastCandidatesRead, 1);
      assert.equal(summary.sourceCollection.unavailableSourceCount, 1);
      assert.equal(summary.spotifyApi.rateLimitedCount, 2);
      assert.equal(summary.spotifyApi.retries, 1);
      assert.equal(summary.spotifyApi.totalCalls, 3);

      const serialized = JSON.stringify({
        summary: run.summary,
        logs: run.logs,
        error: run.error,
      });
      assert.doesNotMatch(serialized, new RegExp(SECRET_TOKEN, "i"));
      assert.doesNotMatch(serialized, /Authorization|Bearer/i);

      const assessment = {
        issues: [],
        fingerprint: "fingerprint-test",
      } as unknown as ConfigurationAssessment;
      const gate = await getFirstRunGate(user.id, assessment);
      assert.equal(gate.realRunAllowed, false);
      assert.equal(gate.requiresSimulation, true);
      assert.match(gate.reason ?? "", /inconclusiva/i);
    } finally {
      globalThis.fetch = originalFetch;
      Math.random = originalRandom;
    }
  },
);

integrationTest(
  "real generation with an incomplete required read performs zero Spotify writes",
  { concurrency: false },
  async (t) => {
    const user = await createFixture({ sources: 2 });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    const originalRandom = Math.random;
    let calls = 0;
    let writes = 0;

    globalThis.fetch = (async (_input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        writes += 1;
        return jsonResponse({ unexpected: true }, { status: 500 });
      }

      calls += 1;
      if (calls === 1) {
        return jsonResponse({
          items: [episode("spotify:episode:real-partial", "show-real-partial")],
          next: null,
        });
      }
      return jsonResponse(
        { error: { status: 429, message: "Too many requests" } },
        { status: 429, headers: { "Retry-After": "0" } },
      );
    }) as typeof fetch;
    Math.random = () => 0;

    try {
      const result = await generatePlaylists({
        userId: user.id,
        trigger: "MANUAL",
        simulate: false,
      });
      assert.equal(result.status, "FAILED");
      assert.equal(writes, 0);

      const run = await readRun(result.runId);
      const summary = summaryObject(run.summary);
      assert.equal(summary.inconclusive, true);
      assert.equal(summary.qualityPassed, false);
      assert.deepEqual(summary.qualityFailures, []);
      assert.match(run.error ?? "", /bloqueada antes de alterar o Spotify/i);
    } finally {
      globalThis.fetch = originalFetch;
      Math.random = originalRandom;
    }
  },
);

integrationTest(
  "one source shared by two destinations is collected once for the run",
  { concurrency: false },
  async (t) => {
    const user = await createFixture({ targets: 2 });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });

    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        items: [
          episode("spotify:episode:target-one", "show-one"),
          episode("spotify:episode:target-two", "show-two"),
        ],
        next: null,
      });
    }) as typeof fetch;

    try {
      const result = await generatePlaylists({
        userId: user.id,
        trigger: "SIMULATION",
        simulate: true,
      });
      assert.equal(result.status, "SUCCESS");
      assert.equal(calls, 1);

      const run = await readRun(result.runId);
      const summary = summaryObject(run.summary);
      assert.equal(summary.qualityPassed, true);
      assert.equal(summary.sourceCollection.readSourceCount, 1);
      assert.equal(summary.sourceCollection.planningRounds, 1);
      assert.equal(summary.targets.length, 2);
      assert.equal(summary.spotifyApi.totalCalls, 1);
      const sourceMetrics = Object.values(summary.spotifyApi.sourceReads);
      assert.equal(sourceMetrics.length, 1);
      assert.equal(sourceMetrics[0]?.pagesRead, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

// Planner/unit tests continue below unchanged in this file.
