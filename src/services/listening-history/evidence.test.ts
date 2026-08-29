import assert from "node:assert/strict";
import test from "node:test";

import {
  inferMusicEvidenceFromSequence,
  inferPodcastContinuationFromSequence,
  preferFactualEvidence,
  readFactualMusicEvidence,
  readFactualPodcastEvidence,
  readRecentlyPlayedDurationMs,
} from "./evidence";

test("Spotify Extended History remains factual and wins over inference", () => {
  const factual = readFactualMusicEvidence(
    {
      spotifyExtendedHistory: {
        msPlayed: 178_000,
        reasonEnd: "trackdone",
        explicitSkip: false,
      },
    },
    180_000,
  );
  const inferred = inferMusicEvidenceFromSequence({
    playedAt: new Date("2026-08-29T10:00:00.000Z"),
    nextPlayedAt: new Date("2026-08-29T10:01:00.000Z"),
    durationMs: 180_000,
  });

  assert.ok(factual);
  assert.equal(factual.level, "FACTUAL");
  assert.equal(factual.status, "COMPLETED");
  assert.equal(factual.listenedMs, 178_000);
  assert.equal(preferFactualEvidence(factual, inferred), factual);
});

test("Recently Played duration metadata is read without provider access", () => {
  assert.equal(
    readRecentlyPlayedDurationMs({
      spotifyRecentlyPlayed: { trackDurationMs: 245_321 },
    }),
    245_321,
  );
  assert.equal(readRecentlyPlayedDurationMs({}), null);
});

test("consecutive music observations can infer a completed listen", () => {
  const evidence = inferMusicEvidenceFromSequence({
    playedAt: new Date("2026-08-29T10:00:00.000Z"),
    nextPlayedAt: new Date("2026-08-29T10:02:58.000Z"),
    durationMs: 180_000,
  });

  assert.ok(evidence);
  assert.equal(evidence.level, "INFERRED");
  assert.equal(evidence.status, "COMPLETED");
  assert.equal(evidence.listenedMs, 178_000);
  assert.equal(evidence.remainingMs, 2_000);
});

test("consecutive music observations preserve inferred partial progress", () => {
  const evidence = inferMusicEvidenceFromSequence({
    playedAt: new Date("2026-08-29T10:00:00.000Z"),
    nextPlayedAt: new Date("2026-08-29T10:01:00.000Z"),
    durationMs: 180_000,
  });

  assert.ok(evidence);
  assert.equal(evidence.status, "PARTIAL");
  assert.equal(evidence.listenedMs, 60_000);
  assert.equal(evidence.remainingMs, 120_000);
});

test("newest music observation stays inconclusive without a following anchor", () => {
  assert.equal(
    inferMusicEvidenceFromSequence({
      playedAt: new Date("2026-08-29T10:00:00.000Z"),
      nextPlayedAt: null,
      durationMs: 180_000,
    }),
    null,
  );
});

test("large unexplained music gap is not promoted to a full listen", () => {
  assert.equal(
    inferMusicEvidenceFromSequence({
      playedAt: new Date("2026-08-29T10:00:00.000Z"),
      nextPlayedAt: new Date("2026-08-29T10:20:00.000Z"),
      durationMs: 180_000,
    }),
    null,
  );
});

test("podcast provider resume point is factual and preserves remaining time", () => {
  const evidence = readFactualPodcastEvidence({
    durationMs: 3_600_000,
    resumePositionMs: 1_800_000,
    fullyPlayed: false,
    status: "IN_PROGRESS",
  });

  assert.equal(evidence.level, "FACTUAL");
  assert.equal(evidence.status, "PARTIAL");
  assert.equal(evidence.listenedMs, 1_800_000);
  assert.equal(evidence.remainingMs, 1_800_000);
});

test("podcast inference continues from known progress instead of restarting", () => {
  const evidence = inferPodcastContinuationFromSequence({
    durationMs: 3_600_000,
    resumePositionMs: 1_800_000,
    sessionStartedAt: new Date("2026-08-29T10:00:00.000Z"),
    nextObservedAt: new Date("2026-08-29T10:15:00.000Z"),
  });

  assert.ok(evidence);
  assert.equal(evidence.level, "INFERRED");
  assert.equal(evidence.status, "PARTIAL");
  assert.equal(evidence.listenedMs, 2_700_000);
  assert.equal(evidence.remainingMs, 900_000);
});

test("podcast inference can close only the remaining bounded duration", () => {
  const evidence = inferPodcastContinuationFromSequence({
    durationMs: 3_600_000,
    resumePositionMs: 1_800_000,
    sessionStartedAt: new Date("2026-08-29T10:00:00.000Z"),
    nextObservedAt: new Date("2026-08-29T10:30:00.000Z"),
  });

  assert.ok(evidence);
  assert.equal(evidence.status, "COMPLETED");
  assert.equal(evidence.listenedMs, 3_600_000);
  assert.equal(evidence.remainingMs, 0);
});
