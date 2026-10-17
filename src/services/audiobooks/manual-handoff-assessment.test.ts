import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { SpotifyTargetPlaylistState } from "@/services/spotify/client";
import {
  assessAudiobookManualHandoff,
  hasAudiobookManualHandoffShadow,
  type AudiobookD3Overlay,
  type AudiobookD3Simulation,
  type AudiobookD3Target,
} from "./manual-handoff-assessment";

const now = Date.parse("2026-10-17T11:00:00Z");
const target: AudiobookD3Target = {
  id: "target-manual",
  userId: "owner-1",
  spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
  durationMode: "FIXED",
  fixedDurationSeconds: 300,
  updatePolicy: "MANUAL",
  compositionMode: "PROPORTION",
};
const overlay: AudiobookD3Overlay = {
  userId: "owner-1",
  targetPlaylistId: target.id,
  spotifyPlaylistId: target.spotifyPlaylistId!,
  spotifyAudiobookId: "5E76EUAq7or1ncd4QNyHjI",
  selectedChapterId: "71PKNrJrxgaYwUY6srGQ3L",
  chapterDurationMs: 20_039,
  manualConsumedMs: 0,
  selectionMode: "FULL_CHAPTER",
  revision: 3,
};
const uris = [
  "spotify:track:" + "a".repeat(22),
  "spotify:episode:" + "b".repeat(22),
];
const projection = {
  status: "READY_SHADOW",
  targetPlaylistId: target.id,
  spotifyPlaylistId: target.spotifyPlaylistId,
  spotifyAudiobookId: overlay.spotifyAudiobookId,
  selectedChapterId: overlay.selectedChapterId,
  overlayRevision: 3,
  chapterDurationMs: 20_039,
  manualConsumedMs: 0,
  targetDurationMs: 300_000,
  virtualChapterDurationMs: 20_039,
  remainingBudgetMs: 279_961,
  projectedExtraDurationMs: 270_000,
  totalProjectedVirtualDurationMs: 290_039,
  leftoverAfterProjectedExtrasMs: 9_961,
  projectedItemCount: 2,
  projectedContentUris: uris,
  candidateCoverage: "TARGET_SCOPED_CONFIGURED_SOURCES_ONLY",
  wholeBookRemainsInSpotify: true,
  remoteBookPresenceVerified: false,
  spotifyWrites: false,
  approvalEligible: false,
  plannerInfluence: false,
};
const summary = {
  simulate: true,
  collectionComplete: true,
  inconclusive: false,
  qualityPassed: false,
  audiobookGateDSimulationOnly: true,
  audiobookGateD: {
    mode: "SHADOW",
    plannerInfluence: false,
    spotifyWrites: false,
    approvalEligible: false,
    targets: [projection],
  },
};
const run: AudiobookD3Simulation = {
  id: "sim-run-1",
  userId: "owner-1",
  simulation: true,
  status: "SUCCESS",
  startedAt: new Date(now - 50_000),
  finishedAt: new Date(now - 40_000),
  summary,
};
const remote: SpotifyTargetPlaylistState = {
  snapshotId: "stable-snapshot",
  items: [{ position: 0, uri: null, type: null, removableByUri: false }],
};
function input(changes: Record<string, unknown> = {}) {
  return { userId: "owner-1", target, overlay, run, remote, nowMs: now, ...changes };
}
function statusIsBlocked(changes: Record<string, unknown>, reason: string) {
  const result = assessAudiobookManualHandoff(input(changes));
  assert.equal(result.status, "BLOCKED");
  if (result.status === "BLOCKED") assert.equal(result.reason, reason);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.authorizedForAutomaticWrite, false);
}

test("#489 D.3: only a genuine recent target-scoped SHADOW summary can be selected", () => {
  assert.equal(hasAudiobookManualHandoffShadow(summary, target.id), true);
  assert.equal(hasAudiobookManualHandoffShadow(summary, "unrelated"), false);
  assert.equal(hasAudiobookManualHandoffShadow({
    ...summary, audiobookGateD: {
      ...summary.audiobookGateD,
      targets: [projection, projection],
    },
  }, target.id), false);
  assert.equal(hasAudiobookManualHandoffShadow({
    ...summary, collectionComplete: false,
  }, target.id), false);
});

test("#489 D.3: 5min playlist yields track/episode handoff, never writer authorization", () => {
  const result = assessAudiobookManualHandoff(input());
  assert.equal(result.status, "MANUAL_HANDOFF_ONLY");
  if (result.status !== "MANUAL_HANDOFF_ONLY") return;
  assert.equal(result.virtualChapterDurationMs, 20_039);
  assert.equal(result.remainingBudgetMs, 279_961);
  assert.equal(result.extraDurationMs, 270_000);
  assert.equal(result.projectedTotalMs, 290_039);
  assert.equal(result.leftoverMs, 9_961);
  assert.equal(result.opaqueItemsObserved, 1);
  assert.equal(result.audiobookIdentityVerified, false);
  assert.equal(result.spotifySnapshotIsWriteAuthorization, false);
  assert.equal(result.authorizedForAutomaticWrite, false);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.requiresManualBookCheck, true);
  assert.equal(result.requiresManualChapterSwitch, true);
  assert.equal(result.spotifyPlaylistUrl,
    "https://open.spotify.com/playlist/4kYizEAtQhFsrrwD3tFphP");
  assert.deepEqual(result.items.map(x => x.spotifyUrl), [
    "https://open.spotify.com/track/" + "a".repeat(22),
    "https://open.spotify.com/episode/" + "b".repeat(22),
  ]);
});

test("#489 D.3: reject different owner, destination drift, invalid policy", () => {
  statusIsBlocked({ userId: "other" }, "DESTINATION_OR_OWNER_MISMATCH");
  statusIsBlocked({ overlay: { ...overlay, spotifyPlaylistId: "different" } },
    "DESTINATION_OR_OWNER_MISMATCH");
  statusIsBlocked({ run: { ...run, userId: "other" } },
    "DESTINATION_OR_OWNER_MISMATCH");
  for (const config of [
    { durationMode: "CALENDAR" },
    { updatePolicy: "KEEP_FILLED" },
    { updatePolicy: "REBUILD_DAILY" },
    { compositionMode: "SEQUENCE" },
    { fixedDurationSeconds: 0 },
    { fixedDurationSeconds: 301 },
  ]) {
    const reason = config.fixedDurationSeconds === 301
      ? "BUDGET_OR_PROGRESS_DRIFT" : "UNSUPPORTED_TARGET_POLICY";
    statusIsBlocked({ target: { ...target, ...config } }, reason);
  }
});

test("#489 D.3: reject non-simulation, stale and interrupted runs", () => {
  statusIsBlocked({ run: { ...run, simulation: false } },
    "MISSING_OR_STALE_SIMULATION");
  statusIsBlocked({ run: { ...run, status: "FAILED" } },
    "MISSING_OR_STALE_SIMULATION");
  statusIsBlocked({ run: { ...run, finishedAt: new Date(now - 4_000_000) } },
    "MISSING_OR_STALE_SIMULATION");
  statusIsBlocked({ run: { ...run, summary: { ...summary, inconclusive: true } } },
    "NO_AUTHORITATIVE_SHADOW_EVIDENCE");
  statusIsBlocked({ run: { ...run, summary: { ...summary, simulate: false } } },
    "NO_AUTHORITATIVE_SHADOW_EVIDENCE");
});

test("#489 D.3: stale chapter revision and chapter switch block old proposed list", () => {
  statusIsBlocked({ overlay: { ...overlay, revision: 4 } },
    "STALE_OR_UNVERIFIED_SHADOW");
  statusIsBlocked({ overlay: { ...overlay, selectedChapterId: "c".repeat(22) } },
    "STALE_OR_UNVERIFIED_SHADOW");
  statusIsBlocked({ overlay: { ...overlay, chapterDurationMs: 19_000 } },
    "BUDGET_OR_PROGRESS_DRIFT");
  statusIsBlocked({ overlay: {
    ...overlay,
    selectionMode: "MANUAL_REMAINDER",
    manualConsumedMs: 5_000,
  } }, "BUDGET_OR_PROGRESS_DRIFT");
  statusIsBlocked({ run: { ...run, summary: {
    ...summary,
    audiobookGateD: {
      ...summary.audiobookGateD,
      targets: [{ ...projection, remoteBookPresenceVerified: true }],
    },
  } } }, "STALE_OR_UNVERIFIED_SHADOW");
});

test("#489 D.3: zero opaques, invalid remote and duplicates block manual handoff", () => {
  statusIsBlocked({ remote: {
    snapshotId: "stable",
    items: [{ position: 0, uri: "spotify:track:" + "z".repeat(22),
      type: "MUSIC", removableByUri: true }],
  } }, "NO_OPAQUE_ITEM_FOR_MANUAL_VERIFICATION");
  statusIsBlocked({ remote: { snapshotId: "", items: remote.items } },
    "INVALID_OR_UNSTABLE_REMOTE_SNAPSHOT");
  statusIsBlocked({ remote: { snapshotId: "ok", items: [
    ...remote.items,
    { position: 1, uri: uris[0], type: "MUSIC", removableByUri: true },
  ] } }, "PROPOSED_ITEMS_ALREADY_IN_PLAYLIST");
});

function projectionWith(changes: Record<string, unknown>) {
  return { ...run, summary: { ...summary, audiobookGateD: {
    ...summary.audiobookGateD,
    targets: [{ ...projection, ...changes }],
  } } };
}

test("#489 D.3: reject unsafe URI, duplicates, over-budget and malformed shadow", () => {
  statusIsBlocked({ run: projectionWith({
    projectedContentUris: ["spotify:audiobook:" + "a".repeat(22), uris[1]],
  }) }, "UNSUPPORTED_SPOTIFY_URI");
  statusIsBlocked({ run: projectionWith({
    projectedContentUris: [uris[0], uris[0]],
  }) }, "DUPLICATE_PROPOSED_ITEM");
  statusIsBlocked({ run: projectionWith({
    projectedExtraDurationMs: 300_000,
  }) }, "BUDGET_OR_PROGRESS_DRIFT");
  statusIsBlocked({ run: projectionWith({
    projectedContentUris: Array.from({ length: 101 }, () => uris[0]),
    projectedItemCount: 101,
  }) }, "EMPTY_OR_OVERSIZED_MANUAL_LIST");
  statusIsBlocked({ run: projectionWith({
    targetPlaylistId: "other",
  }) }, "NO_AUTHORITATIVE_SHADOW_EVIDENCE");
});

test("#489 D.3: proof-of-snapshot never means append CAS or automatic write approval", () => {
  const policy = readFileSync("src/services/audiobooks/manual-handoff-assessment.ts", "utf8");
  const route = readFileSync("src/app/api/audiobooks/manual-handoff/route.ts", "utf8");
  const editor = readFileSync("src/components/AudiobookChapterChangeEditor.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/configuracao/audiolivros/page.tsx", "utf8");
  assert.match(route, /manualAudiobookOriginAllowed/);
  assert.match(route, /AUDIOBOOK02_BIND_UI_MODE/);
  assert.match(route, /AUDIOBOOK02_PLANNER_MODE/);
  assert.match(route, /getTargetPlaylistState/);
  assert.match(page, /handoffPreviewEnabled/);
  assert.match(editor, /Avaliar lista manual da simulação/);
  assert.match(editor, /Nenhuma escrita automática foi autorizada ou realizada/);
  for (const source of [policy, route]) {
    assert.doesNotMatch(source,
      /\.replacePlaylistItems\(|\.appendPlaylistItems\(|\.removePlaylistItems\(|spotifyRequestAttempt\(|spotifyClient\.request\(/);
  }
});
