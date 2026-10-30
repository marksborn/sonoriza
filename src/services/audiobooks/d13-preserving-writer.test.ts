import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { RunTarget } from "@/services/playlist-planner";
import type { SpotifyTargetPlaylistContentItem } from "@/services/spotify/client";

import {
  audiobookPreservingPermitActive,
  audiobookPreservingPermitAllows,
  planPreservingRewrite,
  reserveAudiobookChapterBudget,
  resolveAudiobookPreservingTarget,
  runWithAudiobookPreservingPermit,
  verifyPreservingRewrite,
} from "./d13-preserving-writer";

const ENV = {
  AUDIOBOOK02_PRESERVING_WRITER_MODE: "ACTIVE",
  AUDIOBOOK02_PRESERVING_WRITER_TARGET_IDS: "book-target",
};

const BASE = {
  targetPlaylistId: "book-target",
  spotifyPlaylistId: "PL1",
  updatePolicy: "MANUAL" as const,
  libraryProtectedOnly: true,
  activeReading: { chapterDurationMs: 20_039, consumedMs: 0 },
};

test("D.13 eligibility needs the switch, allowlist, a non KEEP_FILLED target and an active reading", () => {
  assert.deepEqual(resolveAudiobookPreservingTarget(ENV, BASE), {
    targetPlaylistId: "book-target",
    eligible: true,
    reason: "ELIGIBLE",
    reservedMs: 20_039,
  });
  assert.equal(resolveAudiobookPreservingTarget({}, BASE).reason, "MODE_OFF");
  assert.equal(
    resolveAudiobookPreservingTarget(ENV, { ...BASE, targetPlaylistId: "other" }).reason,
    "TARGET_NOT_ALLOWLISTED",
  );
  assert.equal(
    resolveAudiobookPreservingTarget(ENV, { ...BASE, updatePolicy: "KEEP_FILLED" }).reason,
    "KEEP_FILLED_NOT_SUPPORTED",
  );
  assert.equal(
    resolveAudiobookPreservingTarget(ENV, { ...BASE, libraryProtectedOnly: false }).reason,
    "OTHER_AUDIOBOOK_PROTECTION",
  );
  assert.equal(
    resolveAudiobookPreservingTarget(ENV, { ...BASE, activeReading: null }).reason,
    "NO_ACTIVE_READING",
  );
  assert.equal(
    resolveAudiobookPreservingTarget(ENV, {
      ...BASE,
      activeReading: { chapterDurationMs: 60_000, consumedMs: 45_000 },
    }).reservedMs,
    15_000,
  );
});

test("the 1984 example: 5 min playlist keeps 279 961 ms for the plan", () => {
  const target: RunTarget = {
    targetPlaylistId: "book-target",
    name: "Livro",
    priority: 0,
    rules: {
      targetDurationMs: 300_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
    },
  };
  reserveAudiobookChapterBudget(target, 20_039);
  assert.equal(target.rules.targetDurationMs, 279_961);
});

test("per-event blocks absorb the reservation in order", () => {
  const target: RunTarget = {
    targetPlaylistId: "t",
    name: "t",
    priority: 0,
    rules: {
      targetDurationMs: 40 * 60_000,
      compositionMode: "SEQUENCE",
      podcastPercent: 0,
      sequencePattern: ["MUSIC"],
      maxEpisodesPerProgram: 1,
    },
    durationBlocks: [
      { key: "E1", targetDurationMs: 10 * 60_000 },
      { key: "E2", targetDurationMs: 30 * 60_000 },
    ],
  };
  reserveAudiobookChapterBudget(target, 15 * 60_000);
  assert.deepEqual(
    target.durationBlocks?.map((block) => block.targetDurationMs),
    [0, 25 * 60_000],
  );
  assert.equal(target.rules.targetDurationMs, 25 * 60_000);
});

function item(
  position: number,
  uri: string | null,
  type: SpotifyTargetPlaylistContentItem["type"],
): SpotifyTargetPlaylistContentItem {
  return { position, uri, type, removableByUri: Boolean(uri) };
}

test("rewrite plan removes only tracks/episodes and protects opaque or unknown items", () => {
  const state = {
    items: [
      item(0, null, null), // book reported as item=null
      item(1, "spotify:track:a", "MUSIC"),
      item(2, "spotify:audiobook:B00K", null), // unknown kind with URI
      item(3, "spotify:episode:e", "PODCAST"),
      item(4, "spotify:track:a", "MUSIC"),
    ],
  };
  const plan = planPreservingRewrite(state, ["spotify:track:x"]);
  assert.deepEqual(plan.removeUris.sort(), ["spotify:episode:e", "spotify:track:a"]);
  assert.equal(plan.protectedItemCount, 2);
  assert.equal(plan.blockedReason, null);
  assert.equal(
    planPreservingRewrite(state, ["spotify:chapter:c"]).blockedReason,
    "PLANNED_URI_NOT_REMOVABLE_KIND",
  );
});

test("verification fails when a protected item disappears or the order differs", () => {
  const before = planPreservingRewrite({ items: [item(0, null, null)] }, []);
  const final = ["spotify:track:x", "spotify:episode:y"];
  const good = {
    items: [
      item(0, null, null),
      item(1, "spotify:track:x", "MUSIC"),
      item(2, "spotify:episode:y", "PODCAST"),
    ],
  };
  assert.equal(verifyPreservingRewrite(before, good, final).ok, true);

  const bookLost = { items: good.items.slice(1) };
  const lost = verifyPreservingRewrite(before, bookLost, final);
  assert.equal(lost.ok, false);
  assert.equal(lost.protectedAfter, 0);

  const reordered = { items: [good.items[0]!, good.items[2]!, good.items[1]!] };
  assert.equal(verifyPreservingRewrite(before, reordered, final).managedMatchesPlan, false);
});

test("the permit is scoped to one user+playlist and never covers PUT/PATCH", async () => {
  assert.equal(audiobookPreservingPermitActive("u", "PL1"), false);
  await runWithAudiobookPreservingPermit({ userId: "u", spotifyPlaylistId: "PL1" }, async () => {
    assert.equal(audiobookPreservingPermitAllows("u", "PL1", "DELETE"), true);
    assert.equal(audiobookPreservingPermitAllows("u", "PL1", "post"), true);
    assert.equal(audiobookPreservingPermitAllows("u", "PL1", "PUT"), false);
    assert.equal(audiobookPreservingPermitAllows("u", "PL1", "PATCH"), false);
    assert.equal(audiobookPreservingPermitAllows("u", "PL2", "POST"), false);
    assert.equal(audiobookPreservingPermitAllows("other", "PL1", "POST"), false);
  });
  assert.equal(audiobookPreservingPermitAllows("u", "PL1", "POST"), false);
});

test("guards: the permit only relaxes the D.12 library check, never older protections", () => {
  const client = readFileSync("src/services/spotify/client.ts", "utf8");
  const overlay = client.indexOf("prisma.targetAudiobookOverlay.findUnique");
  const notebook = client.indexOf("prisma.targetAudiobookManualNotebook.findFirst");
  const archived = client.indexOf("prisma.userAudiobookCompletedReading.findFirst");
  const permit = client.indexOf("audiobookPreservingPermitAllows(userId, spotifyPlaylistId, method)");
  assert.ok(overlay > 0 && notebook > overlay && archived > notebook && permit > archived);

  const fence = readFileSync("src/services/audiobooks/write-admission-store.ts", "utf8");
  assert.match(
    fence,
    /if \(linked && !audiobookPreservingPermitActive\(userId, spotifyPlaylistId\)\)/,
  );

  const generation = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const writer = generation.slice(generation.indexOf("async function writeAroundAudiobook("));
  assert.doesNotMatch(writer.slice(0, writer.indexOf("\nfunction ")), /replacePlaylistItems/);
});
