import assert from "node:assert/strict";
import test from "node:test";

import {
  planRun,
  type Candidate,
  type RunTarget,
} from "@/services/playlist-planner";
import type { EffectiveSharingPolicy } from "./target-sharing-shadow";
import type { TargetSharingReservationMap } from "./target-sharing-runtime";
import { guardTargetSharingPostprocess } from "./target-sharing-postprocess-guard";

function music(id: string): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: id,
    subtitle: `Artist ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs: 180_000,
  };
}

function target(): RunTarget {
  return {
    targetPlaylistId: "car",
    name: "Carro",
    priority: 0,
    rules: {
      targetDurationMs: 900_000,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxPodcastDurationMs: null,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}

test("#326 postprocessor abstains when optional discovery introduces an external EXCLUSIVE conflict", () => {
  const forbidden = music("forbidden");

  const sharingPolicyByTargetId =
    new Map<string, EffectiveSharingPolicy>([
      ["car", "EXCLUSIVE"],
    ]);

  const externalReservationsByUri: TargetSharingReservationMap =
    new Map([
      [
        forbidden.uri,
        [
          {
            targetPlaylistId: "work",
            sharingPolicy: "EXCLUSIVE",
          },
        ],
      ],
    ]);

  const baseline = planRun({
    pools: {
      music: [
        forbidden,
        music("safe-1"),
        music("safe-2"),
        music("safe-3"),
        music("safe-4"),
        music("safe-5"),
        music("safe-6"),
      ],
      podcasts: [],
    },
    targets: [target()],
    sharingPolicyByTargetId,
    externalReservationsByUri,
  });

  assert.equal(
    baseline.targets[0]!.result.items.some(
      (item) => item.uri === forbidden.uri,
    ),
    false,
  );

  const candidate = {
    ...baseline,
    targets: baseline.targets.map((planned) => {
      const items = planned.result.items.map((item) => ({ ...item }));
      const first = items[0]!;

      items[0] = {
        ...forbidden,
        position: first.position,
        ...(first.planningBlockIndex == null
          ? {}
          : {
              planningBlockIndex:
                first.planningBlockIndex,
            }),
      };

      return {
        ...planned,
        result: {
          ...planned.result,
          items,
          usedUris: new Set(
            items.map((item) => item.uri),
          ),
        },
      };
    }),
  };

  const guarded = guardTargetSharingPostprocess({
    baseline,
    candidate,
    sharingPolicyByTargetId,
    externalReservationsByUri,
  });

  assert.equal(guarded.abstained, true);
  assert.equal(guarded.baselineViolations.length, 0);
  assert.equal(guarded.candidateViolations.length, 1);
  assert.equal(
    guarded.candidateViolations[0]!.source,
    "EXTERNAL_TARGET",
  );
  assert.equal(
    guarded.plan.targets[0]!.result.items.some(
      (item) => item.uri === forbidden.uri,
    ),
    false,
  );
});

test("#326 postprocessor keeps a sharing-safe candidate plan", () => {
  const sharingPolicyByTargetId =
    new Map<string, EffectiveSharingPolicy>([
      ["car", "EXCLUSIVE"],
    ]);

  const baseline = planRun({
    pools: {
      music: [
        music("safe-1"),
        music("safe-2"),
        music("safe-3"),
        music("safe-4"),
        music("safe-5"),
      ],
      podcasts: [],
    },
    targets: [target()],
    sharingPolicyByTargetId,
  });

  const guarded = guardTargetSharingPostprocess({
    baseline,
    candidate: baseline,
    sharingPolicyByTargetId,
  });

  assert.equal(guarded.abstained, false);
  assert.equal(guarded.candidateViolations.length, 0);
  assert.equal(guarded.plan, baseline);
});
