import assert from "node:assert/strict";
import test from "node:test";

import { planRun, type Candidate, type RunTarget } from "@/services/playlist-planner";

import {
  buildLikedTrackArbitrationShadowEvidence,
  interleaveExclusiveLiked,
} from "./liked-track-source-arbitration-shadow";

test("Gate 3C interleaving preserves current order and creates bounded 5/10/20 exposure", () => {
  const current = Array.from({ length: 40 }, (_, index) =>
    candidate(`current-${index}`, 60_000),
  );
  const liked = Array.from({ length: 10 }, (_, index) =>
    candidate(`liked-${index}`, 60_000),
  );

  const five = interleaveExclusiveLiked(current, liked, 5);
  const ten = interleaveExclusiveLiked(current, liked, 10);
  const twenty = interleaveExclusiveLiked(current, liked, 20);

  assert.equal(five[19]?.spotifyTrackId, "liked-0");
  assert.equal(ten[9]?.spotifyTrackId, "liked-0");
  assert.equal(twenty[4]?.spotifyTrackId, "liked-0");
  assert.deepEqual(
    twenty
      .filter((item) => item.spotifyTrackId?.startsWith("current-"))
      .slice(0, 8)
      .map((item) => item.spotifyTrackId),
    current.slice(0, 8).map((item) => item.spotifyTrackId),
  );
});

test("Gate 3C measures current liked representation and compares all variants without mutating the current plan", () => {
  const target = targetRule("target-1", 300_000);
  const currentPool = Array.from({ length: 10 }, (_, index) =>
    candidate(`current-${index}`, 60_000),
  );
  const overlappingLiked = currentPool[1]!;
  const exclusiveLiked = [candidate("liked-new-1", 60_000), candidate("liked-new-2", 60_000)];
  const pools = { music: currentPool, podcasts: [] as Candidate[] };
  const currentPlan = planRun({ pools, targets: [target] });
  const beforeUris = currentPlan.targets[0]!.result.items.map((item) => item.uri);

  const evidence = buildLikedTrackArbitrationShadowEvidence({
    prepared: {
      enabled: true,
      targetIds: new Set(["target-1"]),
      candidates: [overlappingLiked, ...exclusiveLiked],
    },
    context: {
      pools,
      plan: currentPlan,
      targets: [target],
    },
  });

  assert.deepEqual(
    currentPlan.targets[0]!.result.items.map((item) => item.uri),
    beforeUris,
  );
  assert.deepEqual(evidence.exposures, [5, 10, 20]);

  const current = evidence.currentRepresentation[0]!;
  assert.equal(current.selectedLikedCount, 1);
  assert.equal(current.selectedMusicCount, 5);
  assert.equal(current.selectedLikedPercentOfMusic, 20);

  const five = variantTarget(evidence, 5);
  const ten = variantTarget(evidence, 10);
  const twenty = variantTarget(evidence, 20);
  assert.equal(five.exclusiveLikedSelectedCount, 0);
  assert.equal(ten.exclusiveLikedSelectedCount, 0);
  assert.equal(twenty.exclusiveLikedSelectedCount, 1);
  assert.equal(twenty.shadowLikedSelectedCount, 2);
  assert.equal(twenty.deltaLikedSelected, 1);
  assert.equal(twenty.compositionQualityPreserved, true);
  assert.equal(twenty.sequenceQualityPreserved, true);
});

test("Gate 3C removes target-scoped negative signals before exposure", () => {
  const target = targetRule("target-1", 300_000);
  const currentPool = Array.from({ length: 10 }, (_, index) =>
    candidate(`current-${index}`, 60_000),
  );
  const blockedLiked = candidate("liked-blocked", 60_000);
  const allowedLiked = candidate("liked-allowed", 60_000);
  const pools = { music: currentPool, podcasts: [] as Candidate[] };
  const currentPlan = planRun({ pools, targets: [target] });

  const evidence = buildLikedTrackArbitrationShadowEvidence({
    prepared: {
      enabled: true,
      targetIds: new Set(["target-1"]),
      candidates: [blockedLiked, allowedLiked],
    },
    context: {
      pools,
      plan: currentPlan,
      targets: [target],
      blockedMusicTrackIdsByTargetId: new Map([
        ["target-1", new Set(["liked-blocked"])],
      ]),
    },
  });

  const twentyVariant = evidence.variants.find(
    (variant) => variant.exposurePercent === 20,
  );
  assert.ok(twentyVariant);
  const input = recordArray(twentyVariant.targetInputs)[0]!;
  assert.equal(input.exclusiveLikedBeforeNegative, 2);
  assert.equal(input.exclusiveLikedEligible, 1);
  assert.equal(input.negativeSignalBlocked, 1);
});

function variantTarget(
  evidence: ReturnType<typeof buildLikedTrackArbitrationShadowEvidence>,
  exposurePercent: number,
): Record<string, unknown> {
  const variant = evidence.variants.find(
    (item) => item.exposurePercent === exposurePercent,
  );
  assert.ok(variant);
  const target = recordArray(variant.targets)[0];
  assert.ok(target);
  return target;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function candidate(id: string, durationMs: number): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: `Track ${id}`,
    spotifyTrackId: id,
    primaryArtistId: `artist-${id}`,
    primaryArtistName: `Artist ${id}`,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    durationMs,
  };
}

function targetRule(id: string, targetDurationMs: number): RunTarget {
  return {
    targetPlaylistId: id,
    name: id,
    priority: 0,
    rules: {
      targetDurationMs,
      compositionMode: "PROPORTION",
      podcastPercent: 0,
      sequencePattern: [],
      maxEpisodesPerProgram: 1,
      maxTracksPerArtist: null,
      maxTracksPerAlbum: null,
    },
  };
}
