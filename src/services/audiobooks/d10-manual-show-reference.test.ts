import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { Candidate, PlaylistRules } from "@/services/playlist-planner";
import {
  parseManualSpotifyShowReference,
} from "./d10-manual-show-reference";
import {
  projectManualShowChapterPlan,
  type ManualShadowPlanInput,
} from "./d10-manual-shadow-plan";
import {
  MANUAL_NOTEBOOK_CONFIRMATION, parseSaveManualNotebookRequest,
} from "./d7-manual-notebook-contract";

const id = "5E76EUAq7or1ncd4QNyHjI";
const url = "https://open.spotify.com/show/" + id;
test("#489 D.10: book published as Spotify /show/ is an unverified reference", () => {
  assert.deepEqual(parseManualSpotifyShowReference(
    url + "?si=yPjyk9HXTUeRwi_YQf-UPw&utm_source=copy-link",
  ), {
    spotifyShowId: id,
    canonicalUrl: url,
    verifiedAsAudiobook: false,
    providerChapterDataUsed: false,
  });
  assert.equal(parseManualSpotifyShowReference("spotify:show:" + id)?.spotifyShowId, id);
  for (const bad of [
    "", "https://open.spotify.com/audiobook/" + id,
    "https://open.spotify.com/episode/" + id,
    "https://evil.example/show/" + id,
    "http://open.spotify.com/show/" + id,
    "https://open.spotify.com.evil.example/show/" + id,
    "https://open.spotify.com/show/" + id + "/other",
    "https://user@open.spotify.com/show/" + id,
    "https://open.spotify.com/show/../../" + id,
  ]) {
    assert.equal(parseManualSpotifyShowReference(bad), null, bad);
  }
});

const request = {
  targetPlaylistId: "target-01",
  expectedRevision: 0,
  bookTitle: "1984",
  chapterLabel: "Apresentação",
  chapterDurationMs: 20_039,
  selection: { mode: "FULL_CHAPTER" },
  confirmation: MANUAL_NOTEBOOK_CONFIRMATION,
};
test("#489 D.10: D.7 parser retains legacy clients, new show URL becomes ID only", () => {
  const base = parseSaveManualNotebookRequest(request);
  assert.equal(base.ok, true);
  const newer = parseSaveManualNotebookRequest({
    ...request, spotifyShowUrl: url + "?si=tracking",
  });
  assert.equal(newer.ok, true);
  if (newer.ok) {
    assert.equal(newer.value.spotifyShowId, id);
    assert.equal("spotifyShowUrl" in newer.value, false);
  }
  const wrong = parseSaveManualNotebookRequest({
    ...request, spotifyShowUrl: "https://open.spotify.com/audiobook/" + id,
  });
  assert.deepEqual(wrong, { ok: false, code: "INVALID_SPOTIFY_SHOW_REFERENCE" });
});

function music(id: string, duration: number, source = "allowed"): Candidate {
  return {
    uri: "spotify:track:" + id, title: id,
    type: "MUSIC", spotifyTrackId: id,
    sourcePlaylistId: source, durationMs: duration,
  };
}
const rules: PlaylistRules = {
  targetDurationMs: 300_000, compositionMode: "PROPORTION",
  podcastPercent: 0, sequencePattern: ["MUSIC"], maxEpisodesPerProgram: 1,
};
const example: ManualShadowPlanInput = {
  userId: "owner",
  target: {
    id: "target-01", userId: "owner",
    spotifyPlaylistId: "4kYizEAtQhFsrrwD3tFphP",
    durationMode: "FIXED", fixedDurationSeconds: 300,
    updatePolicy: "MANUAL",
  },
  notebook: {
    userId: "owner", targetPlaylistId: "target-01",
    spotifyShowId: id, bookTitle: "1984",
    chapterLabel: "Apresentação",
    chapterDurationMs: 20_039, consumedMs: 0,
    targetDurationMs: 300_000,
    revision: 1,
    evidenceSource: "USER_DECLARED_UNVERIFIED",
  },
  rules,
  pools: {
    music: [
      music("a".repeat(22), 120_000),
      music("b".repeat(22), 150_000),
      music("c".repeat(22), 120_000, "other"),
    ],
    podcasts: [],
  },
  effectiveSourceIds: new Set(["allowed"]),
  hasDurationBlocks: false,
  hasOtherActiveNotebook: false,
};

test("#489 D.10: manual chapter budget uses scoped real pools only in shadow", () => {
  const result = projectManualShowChapterPlan(example);
  assert.equal(result.status, "READY_SHADOW");
  if (result.status !== "READY_SHADOW") return;
  assert.equal(result.virtualChapterDurationMs, 20_039);
  assert.equal(result.remainingBudgetMs, 279_961);
  assert.equal(result.projectedExtraDurationMs, 270_000);
  assert.equal(result.totalVirtualDurationMs, 290_039);
  assert.equal(result.sourceReference, url);
  assert.equal(result.spotifyWrites, false);
  assert.equal(result.approvalEligible, false);
  assert.equal(result.plannerInfluence, false);
  assert.equal(result.remoteBookPresenceVerified, false);
});

test("#489 D.10: fail closed on foreign account, active conflict, policy drift or impossible duration", () => {
  for (const patch of [
    { userId: "stranger" },
    { hasOtherActiveNotebook: true },
    { notebook: { ...example.notebook, spotifyShowId: null } },
    { notebook: { ...example.notebook, chapterDurationMs: 400_000 } },
    { notebook: { ...example.notebook, evidenceSource: "SPOTIFY_VERIFIED" } },
    { target: { ...example.target, updatePolicy: "KEEP_FILLED" } },
    { rules: { ...rules, targetDurationMs: 120_000 } },
    { effectiveSourceIds: new Set<string>() },
  ]) {
    assert.equal(projectManualShowChapterPlan({ ...example, ...patch }).status, "ABSTAIN");
  }
});

test("#489 D.10: no provider write, catalogue identity spoofing, or productive planner mutation", () => {
  const pure = readFileSync("src/services/audiobooks/d10-manual-shadow-plan.ts","utf8");
  const planner = readFileSync("src/jobs/generate-playlists-incremental.ts","utf8");
  const store = readFileSync("src/services/audiobooks/d7-manual-notebook-store.ts","utf8");
  assert.doesNotMatch(pure, /spotifyRequestAttempt|replacePlaylistItems|appendPlaylistItems|prisma\./);
  assert.match(planner, /simulate &&\s*singleReadingEnabled\(process\.env\)/);
  assert.match(planner, /AUDIOBOOK02_MANUAL_PLANNER_MODE === "SHADOW"/);
  assert.match(planner, /REAL_WRITE_BLOCKED/);
  assert.match(store, /SHOW_REFERENCE_CHANGE_REQUIRES_COMPLETION/);
});
