import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Candidate, PlaylistRules } from "@/services/playlist-planner";
import {
  projectAudiobookVirtualChapterPlan,
  type AudiobookGateDProjectionInput,
} from "./gate-d-shadow-planner";

const playlistId = "4kYizEAtQhFsrrwD3tFphP";
const bookId = "5E76EUAq7or1ncd4QNyHjI";
const chapterId = "71PKNrJrxgaYwUY6srGQ3L";

const rules: PlaylistRules = {
  targetDurationMs: 300_000,
  compositionMode: "PROPORTION",
  podcastPercent: 0,
  sequencePattern: ["MUSIC"],
  maxEpisodesPerProgram: 1,
};
function music(
  id: string, durationMs: number, sourcePlaylistId = "source-one",
): Candidate {
  return {
    uri: "spotify:track:" + id,
    type: "MUSIC",
    spotifyTrackId: id,
    title: "Music " + id,
    sourcePlaylistId,
    durationMs,
  };
}
const base: AudiobookGateDProjectionInput = {
  userId: "user-one",
  target: {
    id: "target-one",
    userId: "user-one",
    spotifyPlaylistId: playlistId,
    fixedDurationSeconds: 300,
    durationMode: "FIXED",
    updatePolicy: "MANUAL",
  },
  overlay: {
    userId: "user-one",
    targetPlaylistId: "target-one",
    spotifyPlaylistId: playlistId,
    spotifyAudiobookId: bookId,
    selectedChapterId: chapterId,
    chapterDurationMs: 20_039,
    providerDurationMs: null,
    manualConsumedMs: 0,
    selectionMode: "FULL_CHAPTER",
    revision: 2,
  },
  rules,
  pools: {
    music: [
      music("a".repeat(22), 120_000),
      music("b".repeat(22), 150_000),
      music("c".repeat(22), 120_000, "foreign-source"),
      music("d".repeat(22), 120_000, "source-two"),
    ],
    podcasts: [],
  },
  effectiveSourceIds: new Set(["source-one"]),
};

test("#489 Gate D: virtual chapter occupies 20,039ms, leaving 279,961ms", () => {
  const result = projectAudiobookVirtualChapterPlan(base);
  assert.equal(result.status, "READY_SHADOW");
  if (result.status !== "READY_SHADOW") return;
  assert.equal(result.virtualChapterDurationMs, 20_039);
  assert.equal(result.remainingBudgetMs, 279_961);
  assert.equal(result.chapterDurationMs, 20_039);
  assert.equal(result.targetDurationMs, 300_000);
  assert.equal(result.overlayRevision, 2);
  assert.equal(result.wholeBookRemainsInSpotify, true);
  assert.equal(result.remoteBookPresenceVerified, false);
  assert.equal(result.manualSpotifyControlRequired, true);
  assert.equal(result.plannerInfluence, false);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.approvalEligible, false);
  assert.equal(result.projectedExtraDurationMs, 270_000);
  assert.equal(result.totalProjectedVirtualDurationMs, 290_039);
  assert.equal(result.leftoverAfterProjectedExtrasMs, 9_961);
  assert.deepEqual(result.projectedContentUris,
    ["spotify:track:" + "a".repeat(22), "spotify:track:" + "b".repeat(22)]);
  assert.equal(result.projectedContentUris.some(uri => uri.includes(bookId)), false);
});

test("#489 Gate D: whole-book duration is display-only, never drives budgeting", () => {
  const result = projectAudiobookVirtualChapterPlan({
    ...base,
    overlay: { ...base.overlay, providerDurationMs: 55_320_000 },
  });
  assert.equal(result.status, "READY_SHADOW");
  if (result.status !== "READY_SHADOW") return;
  assert.equal(result.virtualChapterDurationMs, 20_039);
  assert.equal(result.remainingBudgetMs, 279_961);
});

test("#489 Gate D: manual progress of 10,000ms yields 10,039ms virtual chapter", () => {
  const result = projectAudiobookVirtualChapterPlan({
    ...base,
    overlay: {
      ...base.overlay,
      manualConsumedMs: 10_000,
      selectionMode: "MANUAL_REMAINDER",
    },
  });
  assert.equal(result.status, "READY_SHADOW");
  if (result.status !== "READY_SHADOW") return;
  assert.equal(result.virtualChapterDurationMs, 10_039);
  assert.equal(result.remainingBudgetMs, 289_961);
  assert.equal(result.totalProjectedVirtualDurationMs,
    result.virtualChapterDurationMs + result.projectedExtraDurationMs);
});

test("#489 Gate D: scoped candidates only, unknown provenance and skipped tracks excluded", () => {
  const result = projectAudiobookVirtualChapterPlan({
    ...base,
    pools: { ...base.pools,
      music: [
        music("a".repeat(22), 100_000),
        music("b".repeat(22), 100_000, "other-target-source"),
        { ...music("c".repeat(22), 100_000), sourcePlaylistId: undefined },
        music("d".repeat(22), 100_000),
      ] },
    blockedSpotifyMusicTrackIds: new Set(["d".repeat(22)]),
  });
  assert.equal(result.status, "READY_SHADOW");
  if (result.status !== "READY_SHADOW") return;
  assert.deepEqual(result.projectedContentUris, ["spotify:track:" + "a".repeat(22)]);
});

test("#489 Gate D: unknown or changed identities and all unsupported target modes abstain", () => {
  const changes: AudiobookGateDProjectionInput[] = [
    { ...base, userId: "forged" },
    { ...base, target: { ...base.target, spotifyPlaylistId: "another" } },
    { ...base, overlay: { ...base.overlay, userId: "other-user" } },
    { ...base, target: { ...base.target, durationMode: "CALENDAR" } },
    { ...base, target: { ...base.target, updatePolicy: "KEEP_FILLED" } },
    { ...base, target: { ...base.target, updatePolicy: "REBUILD_DAILY" } },
    { ...base, target: { ...base.target, fixedDurationSeconds: 301 } },
    { ...base, rules: { ...rules, compositionMode: "SEQUENCE" } },
    { ...base, effectiveSourceIds: new Set() },
    { ...base, overlay: { ...base.overlay, manualConsumedMs: 1, selectionMode: "FULL_CHAPTER" } },
    { ...base, overlay: { ...base.overlay, revision: -1 } },
  ];
  for (const input of changes) {
    const result = projectAudiobookVirtualChapterPlan(input);
    assert.equal(result.status, "ABSTAIN", JSON.stringify(input.target));
    assert.equal(result.spotifyWrites, false);
    assert.equal(result.approvalEligible, false);
    assert.equal(result.plannerInfluence, false);
  }
});

test("#489 Gate D: overlong, finished and unsafe virtual chapters fail closed", () => {
  for (const overlay of [
    { ...base.overlay, chapterDurationMs: 400_000 },
    { ...base.overlay, selectionMode: "MANUAL_REMAINDER" as const, manualConsumedMs: 20_039 },
    { ...base.overlay, chapterDurationMs: 0 },
    { ...base.overlay, chapterDurationMs: 20_039, manualConsumedMs: 200_000,
      selectionMode: "MANUAL_REMAINDER" as const },
  ]) {
    const projected = projectAudiobookVirtualChapterPlan({ ...base, overlay });
    assert.equal(projected.status, "ABSTAIN");
  }
});

test("#489 Gate D: isolated planner changes neither caller pools nor target rules", () => {
  const before = JSON.stringify(base.pools);
  const beforeRules = JSON.stringify(base.rules);
  projectAudiobookVirtualChapterPlan(base);
  assert.equal(JSON.stringify(base.pools), before);
  assert.equal(JSON.stringify(base.rules), beforeRules);
});

test("#489 Gate D: runtime is gated, no real-run writer can reach a protected batch", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const guardIndex = source.indexOf('if (!simulate && audiobookOverlays.length > 0)');
  const writerIndex = source.indexOf('await writer!.replacePlaylistItems(');
  assert.ok(guardIndex > 0 && writerIndex > guardIndex);
  assert.match(source, /summary\.audiobookGateD/);
  assert.match(source, /audiobookGateDApprovalBlocked/);
  assert.match(source, /AUDIOBOOK02_PLANNER_MODE === "SHADOW"/);
  const planner = readFileSync("src/services/audiobooks/gate-d-shadow-planner.ts", "utf8");
  assert.doesNotMatch(planner, /spotifyRequestAttempt|fetch\(|\.create\(|\.update\(|replacePlaylistItems|appendPlaylistItems/);
});
