import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  projectSingleReadingPreview,
  type ManualReadingCandidate,
} from "./d9-single-reading-preview";

const note: ManualReadingCandidate = {
  userId: "owner",
  targetPlaylistId: "target-1",
  targetName: "Trabalho",
  bookTitle: "1984",
  chapterLabel: "Apresentação",
  chapterDurationMs: 20_039,
  consumedMs: 10_000,
  evidenceSource: "USER_DECLARED_UNVERIFIED",
};

test("#489 D.9.1: no notebook is not a current book", () => {
  assert.deepEqual(projectSingleReadingPreview("owner", []), {
    status: "NONE", spotifyWrites: false, verifiedBySpotify: false,
  });
});

test("#489 D.9.1: one notebook yields manual current-book summary, never Spotify evidence", () => {
  assert.deepEqual(projectSingleReadingPreview("owner", [note]), {
    status: "SINGLE_NOTEBOOK",
    targetPlaylistId: "target-1",
    targetName: "Trabalho",
    bookTitle: "1984",
    chapterLabel: "Apresentação",
    chapterRemainingMs: 10_039,
    spotifyWrites: false,
    verifiedBySpotify: false,
    archivalSupported: false,
  });
});

test("#489 D.9.1: multiple legacy notebooks abstain rather than selecting arbitrary one", () => {
  const r = projectSingleReadingPreview("owner", [
    note, { ...note, targetPlaylistId: "target-2", bookTitle: "Admirável Mundo Novo" },
  ]);
  assert.deepEqual(r, {
    status: "REVIEW_REQUIRED", reason: "MULTIPLE_NOTEBOOKS",
    spotifyWrites: false, verifiedBySpotify: false,
  });
});

test("#489 D.9.1: unauthorized owner and forged Spotify evidence fail closed", () => {
  for (const forged of [
    { ...note, userId: "stranger" },
    { ...note, evidenceSource: "SPOTIFY_VERIFIED" },
    { ...note, bookTitle: "" },
  ]) {
    assert.deepEqual(projectSingleReadingPreview("owner", [forged]), {
      status: "REVIEW_REQUIRED", reason: "INVALID_OWNERSHIP_OR_EVIDENCE",
      spotifyWrites: false, verifiedBySpotify: false,
    });
  }
});

test("#489 D.9.1: invalid durations cannot masquerade as current chapter", () => {
  for (const consumedMs of [-1, 20_039, 20_040, 1.5]) {
    assert.equal(projectSingleReadingPreview("owner", [
      { ...note, consumedMs },
    ]).status, "REVIEW_REQUIRED");
  }
});

test("#489 D.9.1: no writing route, no migration, no release-flag change", () => {
  const page = readFileSync("src/app/dashboard/configuracao/audiolivros/page.tsx", "utf8");
  const fence = readFileSync("src/services/audiobooks/write-admission-store.ts", "utf8");
  assert.match(page, /manualNotebookEnabled\(process\.env\)/);
  assert.match(page, /projectSingleReadingPreview/);
  assert.match(fence, /AUDIOBOOK_BIND_BLOCKED_USER_DECLARED_NOTEBOOK/);
  const projection = readFileSync("src/services/audiobooks/d9-single-reading-preview.ts", "utf8");
  assert.doesNotMatch(projection, /spotifyRequestAttempt|prisma\.|fetch\(|GenerationRun/);
});
