import assert from "node:assert/strict";
import test from "node:test";

import { calendar03TargetPreviewFromSummary } from "./calendar-event-composition-ux";

const TARGET_ID = "carro";

function summary() {
  return {
    calendar03PlannerRuntime: {
      runtimeVersion: "calendar03-gate3-runtime-v1",
      requestedMode: "ACTIVE",
      effectiveMode: "ACTIVE",
      activationReason: "ACTIVE_ALLOWED",
      plannerInfluence: true,
      targets: [
        {
          targetPlaylistId: "other",
          targetName: "Outro",
          status: "READY_SHADOW",
          plannerInfluence: true,
          selectedPodcastUris: ["spotify:episode:other"],
          blockDiagnostics: [],
        },
        {
          targetPlaylistId: TARGET_ID,
          targetName: "Carro",
          status: "READY_SHADOW",
          plannerInfluence: true,
          selectedPodcastUris: [
            "spotify:episode:a",
            null,
            "spotify:episode:b",
          ],
          blockDiagnostics: [
            {
              index: 2,
              key: "event-3",
              targetDurationMs: 900000,
              podcastUsableDurationMs: 780000,
              diagnosticCodes: ["EVENT_PODCAST_SELECTED"],
            },
            {
              index: 0,
              key: "event-1",
              targetDurationMs: 1800000,
              podcastUsableDurationMs: 1680000,
              diagnosticCodes: ["EVENT_PODCAST_SELECTED"],
            },
            {
              index: 1,
              key: "event-2",
              targetDurationMs: 1800000,
              podcastUsableDurationMs: 1680000,
              diagnosticCodes: ["EVENT_PODCAST_DISTRIBUTION_SKIPPED"],
            },
          ],
        },
      ],
    },
  };
}

test("ignores summaries without the CALENDAR-03 runtime contract", () => {
  assert.equal(calendar03TargetPreviewFromSummary(null, TARGET_ID), null);
  assert.equal(
    calendar03TargetPreviewFromSummary(
      { calendar03PlannerRuntime: { runtimeVersion: "other" } },
      TARGET_ID,
    ),
    null,
  );
});

test("returns only evidence for the requested target", () => {
  const preview = calendar03TargetPreviewFromSummary(summary(), TARGET_ID);
  assert.ok(preview);
  assert.equal(preview.targetPlaylistId, TARGET_ID);
  assert.equal(preview.targetName, "Carro");
  assert.equal(preview.status, "READY_SHADOW");
  assert.equal(preview.effectiveMode, "ACTIVE");
  assert.equal(preview.activationReason, "ACTIVE_ALLOWED");
  assert.equal(preview.plannerInfluence, true);
  assert.deepEqual(preview.selectedPodcastUris, [
    "spotify:episode:a",
    "spotify:episode:b",
  ]);
});

test("keeps block diagnostics in chronological index order", () => {
  const preview = calendar03TargetPreviewFromSummary(summary(), TARGET_ID);
  assert.ok(preview);
  assert.deepEqual(
    preview.blocks.map((block) => block.index),
    [0, 1, 2],
  );
  assert.deepEqual(preview.blocks[1]?.diagnosticCodes, [
    "EVENT_PODCAST_DISTRIBUTION_SKIPPED",
  ]);
});

test("does not reuse evidence from another target", () => {
  assert.equal(
    calendar03TargetPreviewFromSummary(summary(), "missing-target"),
    null,
  );
});
