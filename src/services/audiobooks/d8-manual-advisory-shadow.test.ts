import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "@/lib/prisma";
import { AudiobookManualAdvisory } from "@/components/AudiobookManualAdvisory";
import { MANUAL_NOTEBOOK_CONFIRMATION } from "./d7-manual-notebook-contract";
import { saveUserDeclaredAudiobookNotebook } from "./d7-manual-notebook-store";
import {
  projectUserDeclaredAudiobookAdvisory,
  type ManualAdvisoryInput,
  type ManualAdvisoryResult,
} from "./d8-manual-advisory-shadow";
import { readManualAdvisoryForOwner } from "./d8-manual-advisory-store";

const spotifyPlaylistId = "4kYizEAtQhFsrrwD3tFphP";
const base: ManualAdvisoryInput = {
  ownerId: "owner-a",
  expectedRevision: 2,
  target: {
    id: "target-123", userId: "owner-a", spotifyPlaylistId,
    durationMode: "FIXED", fixedDurationSeconds: 300,
    compositionMode: "PROPORTION", updatePolicy: "MANUAL",
    podcastPercent: 60, hasVerifiedOverlay: false,
  },
  notebook: {
    userId: "owner-a", targetPlaylistId: "target-123", revision: 2,
    bookTitle: "1984", chapterLabel: "Apresentação",
    chapterDurationMs: 20_039, consumedMs: 0, targetDurationMs: 300_000,
    evidenceSource: "USER_DECLARED_UNVERIFIED",
  },
  sampleMusicDurationsMs: [90_000, 120_000],
  samplePodcastDurationsMs: [120_000],
};

function assertSafe(r: ManualAdvisoryResult) {
  assert.equal(r.durationEvidence, "USER_DECLARED_UNVERIFIED");
  assert.equal(r.sampleEvidence, "HYPOTHETICAL_USER_ENTERED_DURATIONS");
  assert.equal(r.chapterVerifiedBySpotify, false);
  assert.equal(r.remoteBookPresenceVerified, false);
  assert.equal(r.spotifyWrites, false);
  assert.equal(r.bindingEligible, false);
  assert.equal(r.plannerInfluence, false);
  assert.equal(r.approvalEligible, false);
  assert.equal(r.persistentSimulation, false);
  assert.equal("spotifyAudiobookId" in r, false);
  assert.equal("selectedChapterId" in r, false);
  assert.equal("spotifyPlaylistId" in r, false);
  assert.equal("projectedContentUris" in r, false);
}

test("#489 D.8: declared 20.039s in 5min leaves 279.961s and buckets hypothetical blocks", () => {
  const r = projectUserDeclaredAudiobookAdvisory(base);
  assert.equal(r.status, "READY_ADVISORY");
  assertSafe(r);
  if (r.status !== "READY_ADVISORY") return;
  assert.equal(r.notebookRevision, 2);
  assert.equal(r.virtualChapterDurationMs, 20_039);
  assert.equal(r.remainingBudgetMs, 279_961);
  assert.equal(r.musicBudgetMs, 111_985);
  assert.equal(r.podcastBudgetMs, 167_976);
  assert.equal(r.hypotheticalMusicCount, 1);
  assert.equal(r.hypotheticalPodcastCount, 1);
  assert.equal(r.hypotheticalMusicDurationMs, 90_000);
  assert.equal(r.hypotheticalPodcastDurationMs, 120_000);
  assert.equal(r.hypotheticalExtrasMs, 210_000);
  assert.equal(r.hypotheticalTotalVirtualDurationMs, 230_039);
  assert.equal(r.budgetUnfilledMs, 69_961);
});

test("#489 D.8: manually consumed part changes chapter only; no automatic progression", () => {
  const r = projectUserDeclaredAudiobookAdvisory({
    ...base, notebook: { ...base.notebook, consumedMs: 10_000 },
  });
  assert.equal(r.status, "READY_ADVISORY");
  assertSafe(r);
  if (r.status === "READY_ADVISORY") {
    assert.equal(r.virtualChapterDurationMs, 10_039);
    assert.equal(r.remainingBudgetMs, 289_961);
    assert.equal(r.manualSpotifyControlRequired, true);
  }
});

test("#489 D.8: owner, revision, provider provenance and destination mismatches abstain", () => {
  const cases: Array<[ManualAdvisoryInput, string]> = [
    [{ ...base, ownerId: "other" }, "OWNER_OR_DESTINATION_MISMATCH"],
    [{ ...base, target: { ...base.target, userId: "other" } }, "OWNER_OR_DESTINATION_MISMATCH"],
    [{ ...base, notebook: { ...base.notebook, userId: "other" } }, "OWNER_OR_DESTINATION_MISMATCH"],
    [{ ...base, notebook: { ...base.notebook, targetPlaylistId: "elsewhere" } }, "OWNER_OR_DESTINATION_MISMATCH"],
    [{ ...base, target: { ...base.target, spotifyPlaylistId: null } }, "OWNER_OR_DESTINATION_MISMATCH"],
    [{ ...base, expectedRevision: 1 }, "STALE_OR_INVALID_NOTEBOOK_REVISION"],
    [{ ...base, expectedRevision: 3 }, "STALE_OR_INVALID_NOTEBOOK_REVISION"],
    [{ ...base, notebook: { ...base.notebook, evidenceSource: "SPOTIFY_VERIFIED" } }, "INVALID_PROVENANCE"],
    [{ ...base, target: { ...base.target, hasVerifiedOverlay: true } }, "VERIFIED_OVERLAY_PRESENT"],
  ];
  for (const [v, reason] of cases) {
    const result = projectUserDeclaredAudiobookAdvisory(v);
    assert.equal(result.status, "ABSTAIN");
    assertSafe(result);
    if (result.status === "ABSTAIN") assert.equal(result.reason, reason);
  }
});

test("#489 D.8: drifted target policy/budget and invalid percentages abstain", () => {
  for (const target of [
    { ...base.target, fixedDurationSeconds: 301 },
    { ...base.target, fixedDurationSeconds: 0 },
    { ...base.target, durationMode: "CALENDAR" },
    { ...base.target, compositionMode: "SEQUENCE" },
    { ...base.target, updatePolicy: "KEEP_FILLED" },
    { ...base.target, podcastPercent: -1 },
    { ...base.target, podcastPercent: 101 },
  ]) {
    const r = projectUserDeclaredAudiobookAdvisory({ ...base, target });
    assert.equal(r.status, "ABSTAIN");
    assertSafe(r);
    if (r.status === "ABSTAIN") assert.equal(r.reason,
      "TARGET_CONFIGURATION_UNSUPPORTED_OR_DRIFTED");
  }
});

test("#489 D.8: invalid samples/over-budget chapter never truncate or write", () => {
  const sampleCases = [
    { ...base, sampleMusicDurationsMs: [], samplePodcastDurationsMs: [] },
    { ...base, sampleMusicDurationsMs: [-1] },
    { ...base, sampleMusicDurationsMs: [0] },
    { ...base, sampleMusicDurationsMs: [NaN] },
    { ...base, sampleMusicDurationsMs: [Infinity] },
    { ...base, sampleMusicDurationsMs: [1.5] },
    { ...base, sampleMusicDurationsMs: new Array<number>(13).fill(10_000) },
  ];
  for (const input of sampleCases) {
    const r = projectUserDeclaredAudiobookAdvisory(input);
    assert.equal(r.status, "ABSTAIN");
    assertSafe(r);
    if (r.status === "ABSTAIN") assert.equal(r.reason, "INVALID_HYPOTHETICAL_SAMPLES");
  }
  const over = projectUserDeclaredAudiobookAdvisory({
    ...base,
    notebook: { ...base.notebook, chapterDurationMs: 400_000 },
  });
  assert.equal(over.status, "ABSTAIN");
  assertSafe(over);
  const finished = projectUserDeclaredAudiobookAdvisory({
    ...base,
    notebook: { ...base.notebook, consumedMs: 20_039 },
  });
  assert.equal(finished.status, "ABSTAIN");
  assertSafe(finished);
});

test("#489 D.8: mixed durations are hypothetical, immutable inputs and never add URI", () => {
  const snapshot = JSON.stringify(base);
  const r = projectUserDeclaredAudiobookAdvisory(base);
  assert.equal(JSON.stringify(base), snapshot);
  assertSafe(r);
  if (r.status === "READY_ADVISORY") {
    assert.equal(r.hypotheticalExtrasMs <= r.remainingBudgetMs, true);
    assert.equal(r.hypotheticalTotalVirtualDurationMs <= r.targetDurationMs, true);
  }
});

test("#489 D.8: SSR displays illustrative samples and no productive Spotify action", () => {
  const html = renderToStaticMarkup(React.createElement(AudiobookManualAdvisory, {
    targetPlaylistId: "target-123", expectedRevision: 2,
  }));
  assert.match(html, /Gate D.8/);
  assert.match(html, /hipotéticas/);
  assert.match(html, /Simular mistura hipotética \(sem salvar\)/);
  assert.match(html, /não seleciona faixas reais/);
  assert.doesNotMatch(html, /Aplicar|Salvar playlist|Substituir playlist/);
});

test("#489 D.8: route opt-in and read-only boundaries are explicit in source", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const pure = read("src/services/audiobooks/d8-manual-advisory-shadow.ts");
  const store = read("src/services/audiobooks/d8-manual-advisory-store.ts");
  const route = read("src/app/api/audiobooks/manual-advisory/route.ts");
  const page = read("src/app/dashboard/configuracao/audiolivros/page.tsx");
  const ui = read("src/components/AudiobookSelfReportedPreview.tsx");
  const writer = read("src/services/spotify/client.ts");
  assert.match(route, /AUDIOBOOK02_MANUAL_SHADOW_MODE === "PREVIEW"/);
  assert.match(route, /manualNotebookEnabled\(env\)/);
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(store, /userId: input\.ownerId/);
  assert.match(store, /projectUserDeclaredAudiobookAdvisory/);
  assert.match(page, /AUDIOBOOK02_MANUAL_SHADOW_MODE === "PREVIEW"/);
  assert.match(ui, /advisoryEnabled && notebook && selected/);
  assert.match(writer, /targetAudiobookManualNotebook/);
  for (const s of [pure, store, route]) {
    assert.doesNotMatch(s, /SpotifyClient|spotifyRequestAttempt|GenerationRun\.create|\.create\(|\.update\(|\.delete\(|replacePlaylistItems|appendPlaylistItems|planPlaylist\(/);
  }
});

const dbTest = process.env.DATABASE_URL ? test : test.skip;

dbTest("#489 D.8: server projection reads only owner notebook and declines stale budget",
  { concurrency: false }, async t => {
    const suffix = randomUUID().replaceAll("-", "");
    const user = await prisma.user.create({ data: {
      email: "d8-owner-" + suffix + "@example.test",
    } });
    const stranger = await prisma.user.create({ data: {
      email: "d8-other-" + suffix + "@example.test",
    } });
    t.after(async () => {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.user.delete({ where: { id: stranger.id } });
    });
    const target = await prisma.targetPlaylist.create({
      data: {
        userId: user.id,
        name: "D8 fixed-test",
        spotifyPlaylistId,
        durationMode: "FIXED",
        fixedDurationSeconds: 300,
        updatePolicy: "MANUAL",
        compositionMode: "PROPORTION",
        podcastPercent: 60,
        sequencePattern: ["MUSIC"],
      },
    });
    const snapshot = await saveUserDeclaredAudiobookNotebook(user.id, {
      targetPlaylistId: target.id, expectedRevision: 0,
      bookTitle: "1984", chapterLabel: "Apresentação",
      chapterDurationMs: 20_039,
      selection: { mode: "FULL_CHAPTER" },
      confirmation: MANUAL_NOTEBOOK_CONFIRMATION,
    });
    const p = {
      targetPlaylistId: target.id,
      expectedRevision: snapshot.revision,
      sampleMusicDurationsMs: [90_000, 120_000],
      samplePodcastDurationsMs: [120_000],
    };
    const a = await readManualAdvisoryForOwner({ ...p, ownerId: user.id });
    assert.equal(a?.status, "READY_ADVISORY");
    if (a) assertSafe(a);
    const foreign = await readManualAdvisoryForOwner({ ...p, ownerId: stranger.id });
    assert.equal(foreign, null);
    const revised = await saveUserDeclaredAudiobookNotebook(user.id, {
      targetPlaylistId: target.id, expectedRevision: 1,
      bookTitle: "1984", chapterLabel: "Capítulo 2",
      chapterDurationMs: 30_000,
      selection: { mode: "MANUAL_REMAINDER", consumedMs: 10_000 },
      confirmation: MANUAL_NOTEBOOK_CONFIRMATION,
    });
    assert.equal(revised.revision, 2);
    const stale = await readManualAdvisoryForOwner({ ...p, ownerId: user.id });
    assert.equal(stale?.status, "ABSTAIN");
    if (stale?.status === "ABSTAIN") {
      assert.equal(stale.reason, "STALE_OR_INVALID_NOTEBOOK_REVISION");
    }
    const current = await readManualAdvisoryForOwner({
      ...p, expectedRevision: 2, ownerId: user.id,
    });
    assert.equal(current?.status, "READY_ADVISORY");
    if (current?.status === "READY_ADVISORY") {
      assert.equal(current.virtualChapterDurationMs, 20_000);
    }
    await prisma.targetPlaylist.update({ where: { id: target.id }, data: {
      fixedDurationSeconds: 301,
    } });
    const drift = await readManualAdvisoryForOwner({
      ...p, expectedRevision: 2, ownerId: user.id,
    });
    assert.equal(drift?.status, "ABSTAIN");
    if (drift?.status === "ABSTAIN") {
      assert.equal(drift.reason, "TARGET_CONFIGURATION_UNSUPPORTED_OR_DRIFTED");
    }
    assert.equal((await prisma.generationRun.count({ where: { userId: user.id } })), 0);
    assert.equal((await prisma.targetAudiobookOverlay.count({ where: {
      userId: user.id,
    } })), 0);
  });
