import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { prisma } from "@/lib/prisma";
import type { Candidate, PlaylistRules } from "@/services/playlist-planner";
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";
import { AudiobookChapterChangeEditor } from "@/components/AudiobookChapterChangeEditor";
import {
  documentedAudiobookMarketStatus,
  rehearseAudiobookManualFlowOffline,
  type D4OfflineRehearsalInput,
} from "./d4-offline-homologation";

const bookId = "5E76EUAq7or1ncd4QNyHjI";
const chapterId = "71PKNrJrxgaYwUY6srGQ3L";
const playlistId = "4kYizEAtQhFsrrwD3tFphP";
const now = Date.parse("2026-10-17T12:00:00Z");
const rules: PlaylistRules = {
  targetDurationMs: 300_000,
  compositionMode: "PROPORTION",
  podcastPercent: 0,
  sequencePattern: ["MUSIC"],
  maxEpisodesPerProgram: 1,
};
const candidates: Candidate[] = [
  {
    uri: "spotify:track:" + "a".repeat(22),
    type: "MUSIC",
    spotifyTrackId: "a".repeat(22),
    title: "Track A",
    durationMs: 120_000,
    sourcePlaylistId: "owned-source",
  },
  {
    uri: "spotify:track:" + "b".repeat(22),
    type: "MUSIC",
    spotifyTrackId: "b".repeat(22),
    title: "Track B",
    durationMs: 150_000,
    sourcePlaylistId: "owned-source",
  },
  {
    uri: "spotify:track:" + "c".repeat(22),
    type: "MUSIC",
    spotifyTrackId: "c".repeat(22),
    title: "Foreign",
    durationMs: 180_000,
    sourcePlaylistId: "foreign-source",
  },
];

const playlist: SpotifyTargetPlaylistState = {
  snapshotId: "snapshot-before-and-after-the-same",
  items: [{ position: 0, uri: null, type: null, removableByUri: false }],
};

function fixture(overrides: Partial<D4OfflineRehearsalInput> = {}): D4OfflineRehearsalInput {
  return {
    userId: "user-d4",
    accountMarketFixture: "US",
    target: {
      id: "target-d4",
      userId: "user-d4",
      spotifyPlaylistId: playlistId,
      durationMode: "FIXED",
      fixedDurationSeconds: 300,
      updatePolicy: "MANUAL",
    },
    overlay: {
      userId: "user-d4",
      targetPlaylistId: "target-d4",
      spotifyPlaylistId: playlistId,
      spotifyAudiobookId: bookId,
      selectedChapterId: chapterId,
      chapterDurationMs: 20_039,
      providerDurationMs: null,
      manualConsumedMs: 0,
      selectionMode: "FULL_CHAPTER",
      revision: 1,
    },
    rules,
    pools: { music: candidates, podcasts: [] },
    effectiveSourceIds: new Set(["owned-source"]),
    remote: playlist,
    nowMs: now,
    readFixture: providerReadFixture().read,
    ...overrides,
  };
}

function providerReadFixture(options: {
  catalogueUnavailable?: boolean;
  chapterDurationMs?: number;
  playable?: boolean;
  selectedInList?: boolean;
  chapterBookId?: string;
} = {}) {
  const paths: string[] = [];
  const read = async (path: string): Promise<unknown> => {
    paths.push(path);
    if (options.catalogueUnavailable) {
      throw new Error("MOCKED_PROVIDER_403_OR_MARKET_UNAVAILABLE");
    }
    if (path === "/audiobooks/" + bookId) {
      return { id: bookId, type: "audiobook", name: "1984" };
    }
    if (path === "/audiobooks/" + bookId + "/chapters?limit=50&offset=0") {
      return {
        total: 1,
        offset: 0,
        items: [{
          id: options.selectedInList === false ? "f".repeat(22) : chapterId,
          name: "Apresentação",
          type: "episode",
          duration_ms: options.chapterDurationMs ?? 20_039,
          is_playable: options.playable ?? true,
        }],
      };
    }
    if (path === "/chapters/" + chapterId) {
      return {
        id: chapterId,
        name: "Apresentação",
        type: "episode",
        duration_ms: options.chapterDurationMs ?? 20_039,
        is_playable: options.playable ?? true,
        audiobook: { id: options.chapterBookId ?? bookId, type: "audiobook" },
      };
    }
    throw new Error("Unexpected mock Spotify request " + path);
  };
  return { paths, read };
}

test("#489 D.4: market matrix matches documented Spotify audiobook API countries", () => {
  for (const market of ["US", "GB", "CA", "IE", "NZ", "AU"]) {
    assert.equal(documentedAudiobookMarketStatus(market), "DOCUMENTED_MARKET");
  }
  for (const market of ["BR", "AR", "FR", "PT", "ES"]) {
    assert.equal(documentedAudiobookMarketStatus(market),
      "AUDIOBOOK_CATALOG_MARKET_NOT_DOCUMENTED");
  }
  for (const market of [null, "", "us", "USA", "A1"]) {
    assert.equal(documentedAudiobookMarketStatus(market),
      "ACCOUNT_MARKET_UNVERIFIED");
  }
});

test("#489 D.4: controlled fixture exercises catalogue → verified chapter → Gate D → D.3 handoff", async () => {
  const reader = providerReadFixture();
  const result = await rehearseAudiobookManualFlowOffline(fixture({
    readFixture: reader.read,
  }));
  assert.equal(result.status, "PASS_OFFLINE_MANUAL_ONLY");
  if (result.status !== "PASS_OFFLINE_MANUAL_ONLY") return;
  assert.equal(result.audiobookName, "1984");
  assert.equal(result.chapterName, "Apresentação");
  assert.equal(result.virtualChapterDurationMs, 20_039);
  assert.equal(result.remainingBudgetMs, 279_961);
  assert.equal(result.extraDurationMs, 270_000);
  assert.equal(result.leftoverMs, 9_961);
  assert.equal(result.handoffCount, 2);
  assert.deepEqual(result.spotifyUrlsForHumanReview, [
    "https://open.spotify.com/track/" + "a".repeat(22),
    "https://open.spotify.com/track/" + "b".repeat(22),
  ]);
  assert.equal(result.fixtureOnly, true);
  assert.equal(result.realSpotifyAvailabilityVerified, false);
  assert.equal(result.remoteAudiobookIdentityVerified, false);
  assert.equal(result.productionApproved, false);
  assert.equal(result.spotifyWrites, false);
  // The catalogue and ownership validators intentionally perform separate
  // GETs for the same book; this is correct and does not imply mutation.
  assert.deepEqual(reader.paths.sort(), [
    "/audiobooks/" + bookId,
    "/audiobooks/" + bookId,
    "/audiobooks/" + bookId + "/chapters?limit=50&offset=0",
    "/chapters/" + chapterId,
  ].sort());
  assert.ok(reader.paths.every(path => path.startsWith("/")));
});

test("#489 D.4: account market BR stops BEFORE contacting even a simulated provider", async () => {
  const mock = providerReadFixture();
  const result = await rehearseAudiobookManualFlowOffline(fixture({
    accountMarketFixture: "BR",
    readFixture: mock.read,
  }));
  assert.equal(result.status, "BLOCKED_OFFLINE");
  if (result.status === "BLOCKED_OFFLINE") {
    assert.equal(result.reason, "AUDIOBOOK_CATALOG_MARKET_NOT_DOCUMENTED");
  }
  assert.deepEqual(mock.paths, []);
  assert.equal(result.productionApproved, false);
});

test("#489 D.4: unavailable chapter API (403/404/429 fixture) yields no manual approval", async () => {
  const mock = providerReadFixture({ catalogueUnavailable: true });
  const result = await rehearseAudiobookManualFlowOffline(fixture({
    readFixture: mock.read,
  }));
  assert.equal(result.status, "BLOCKED_OFFLINE");
  if (result.status === "BLOCKED_OFFLINE") {
    assert.equal(result.reason, "CATALOG_OR_CHAPTER_GET_UNAVAILABLE");
  }
  assert.equal(result.spotifyWrites, false);
});

test("#489 D.4: catalog disagreement, wrong audiobook, unplayable chapter fail closed", async () => {
  for (const [opts, reason] of [
    [{ selectedInList: false }, "CHAPTER_NOT_IN_CATALOG"],
    [{ chapterDurationMs: 30_000 }, "CHAPTER_EVIDENCE_DRIFT"],
    [{ playable: false }, "CATALOG_OR_CHAPTER_GET_UNAVAILABLE"],
    [{ chapterBookId: "b".repeat(22) }, "CATALOG_OR_CHAPTER_GET_UNAVAILABLE"],
  ] as const) {
    const reader = providerReadFixture(opts);
    const result = await rehearseAudiobookManualFlowOffline(fixture({
      readFixture: reader.read,
    }));
    assert.equal(result.status, "BLOCKED_OFFLINE");
    if (result.status === "BLOCKED_OFFLINE") assert.equal(result.reason, reason);
    assert.equal(result.productionApproved, false);
  }
});

test("#489 D.4: unknown remote book, empty playlist, wrong target and overbudget block", async () => {
  const invalidCases: Array<{
    overrides: Partial<D4OfflineRehearsalInput>;
    reason: string;
  }> = [
    {
      overrides: { remote: { snapshotId: "same", items: [] } },
      reason: "MANUAL_HANDOFF_BLOCKED",
    },
    {
      overrides: { target: { ...fixture().target, fixedDurationSeconds: 2 } },
      reason: "PLANNER_ABSTAIN",
    },
    {
      overrides: { overlay: { ...fixture().overlay, targetPlaylistId: "different" } },
      reason: "CHAPTER_EVIDENCE_DRIFT",
    },
    {
      overrides: { remote: { snapshotId: "", items: playlist.items } },
      reason: "MANUAL_HANDOFF_BLOCKED",
    },
  ];
  for (const { overrides, reason } of invalidCases) {
    const result = await rehearseAudiobookManualFlowOffline(fixture(overrides));
    assert.equal(result.status, "BLOCKED_OFFLINE");
    if (result.status === "BLOCKED_OFFLINE") assert.equal(result.reason, reason);
    assert.equal(result.spotifyWrites, false);
  }
});

const databaseTest = process.env.DATABASE_URL ? test : test.skip;
databaseTest("#489 D.4: real Prisma target/overlay read works with fake Spotify, no provider writes",
  { concurrency: false }, async t => {
    const uid = randomUUID().replaceAll("-", "");
    const user = await prisma.user.create({
      data: { email: "audiobook-d4-" + uid + "@example.test" },
    });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
    });
    const created = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        spotifyPlaylistId: playlistId,
        name: "D.4 disposable preview",
        durationMode: "FIXED",
        fixedDurationSeconds: 300,
        compositionMode: "PROPORTION",
        updatePolicy: "MANUAL",
        sequencePattern: ["MUSIC"],
      },
    });
    await prisma.targetAudiobookOverlay.create({
      data: {
        userId: user.id,
        targetPlaylistId: created.id,
        spotifyPlaylistId: playlistId,
        spotifyAudiobookId: bookId,
        selectedChapterId: chapterId,
        chapterDurationMs: 20_039,
        providerDurationMs: null,
        manualConsumedMs: 0,
        selectionMode: "FULL_CHAPTER",
        revision: 1,
      },
    });
    const persisted = await prisma.targetPlaylist.findUniqueOrThrow({
      where: { id: created.id },
      include: { audiobookOverlay: true },
    });
    assert.ok(persisted.audiobookOverlay);
    const mock = providerReadFixture();
    const result = await rehearseAudiobookManualFlowOffline({
      ...fixture(),
      userId: user.id,
      target: {
        id: persisted.id,
        userId: persisted.userId,
        spotifyPlaylistId: persisted.spotifyPlaylistId,
        durationMode: persisted.durationMode,
        fixedDurationSeconds: persisted.fixedDurationSeconds,
        updatePolicy: persisted.updatePolicy,
      },
      overlay: {
        userId: persisted.audiobookOverlay!.userId,
        targetPlaylistId: persisted.audiobookOverlay!.targetPlaylistId,
        spotifyPlaylistId: persisted.audiobookOverlay!.spotifyPlaylistId,
        spotifyAudiobookId: persisted.audiobookOverlay!.spotifyAudiobookId,
        selectedChapterId: persisted.audiobookOverlay!.selectedChapterId,
        chapterDurationMs: persisted.audiobookOverlay!.chapterDurationMs,
        providerDurationMs: persisted.audiobookOverlay!.providerDurationMs,
        manualConsumedMs: persisted.audiobookOverlay!.manualConsumedMs,
        selectionMode: persisted.audiobookOverlay!.selectionMode,
        revision: persisted.audiobookOverlay!.revision,
      },
      readFixture: mock.read,
    });
    assert.equal(result.status, "PASS_OFFLINE_MANUAL_ONLY");
    assert.equal(result.productionApproved, false);
    assert.equal(result.spotifyWrites, false);
    assert.equal(await prisma.targetAudiobookOverlay.count({
      where: { userId: user.id, targetPlaylistId: created.id },
    }), 1);
    assert.equal((await prisma.targetAudiobookWriteFence.findMany({
      where: { userId: user.id },
    })).length, 0);
  });

test("#489 D.4: SSR static UI has explicit manual controls and no apply-to-Spotify action", () => {
  const html = renderToStaticMarkup(React.createElement(AudiobookChapterChangeEditor, {
    overlay: {
      targetPlaylistId: "target-d4",
      targetName: "My audiobook target",
      spotifyPlaylistId: playlistId,
      spotifyAudiobookId: bookId,
      selectedChapterId: chapterId,
      chapterDurationMs: 20_039,
      manualConsumedMs: 0,
      selectionMode: "FULL_CHAPTER",
      revision: 1,
      targetDurationMs: 300_000,
    },
    changeEnabled: false,
    handoffPreviewEnabled: true,
  }));
  assert.ok(html.includes("Avaliar lista manual da simulação"));
  assert.ok(html.includes("Consultar snapshot remoto"));
  assert.ok(html.includes("O Sonoriza não os enviará"));
  assert.ok(html.includes("audiolivro"));
  assert.equal(html.includes("Aplicar no Spotify"), false);
});

test("#489 D.4: route and safety controls cannot provide a productive write path", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  const route = read("src/app/api/audiobooks/manual-handoff/route.ts");
  const page = read("src/app/dashboard/configuracao/audiolivros/page.tsx");
  const scenario = read("src/services/audiobooks/d4-offline-homologation.ts");
  const runner = read("src/jobs/generate-playlists-incremental.ts");
  assert.ok(route.includes('process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW"'));
  assert.ok(route.includes('process.env.AUDIOBOOK02_PLANNER_MODE !== "SHADOW"'));
  assert.ok(page.includes("handoffPreviewEnabled"));
  assert.ok(runner.includes('if (!simulate && audiobookOverlays.length > 0)'));
  for (const text of [route, scenario]) {
    assert.doesNotMatch(text,
      /(?:\.appendPlaylistItems|\.replacePlaylistItems|\.removePlaylistItems|spotifyRequestAttempt|fetch\()/);
  }
});
