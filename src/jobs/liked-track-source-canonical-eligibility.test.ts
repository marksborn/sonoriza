import assert from "node:assert/strict";
import test from "node:test";

import {
  planRun,
  type Candidate,
  type RunTarget,
} from "@/services/playlist-planner";

import {
  applyLikedTrackSourceShadowForCurrentRun,
  type PreparedLikedTrackSourceShadow,
} from "./liked-track-source-shadow";

import {
  lastFmMusicIdentityKey,
  runWithMusicRepeatState,
  type MusicRepeatRunState,
} from "./music-repeat-runtime";

test(
  "productive liked pilot cannot reintroduce factual Last.fm cooldown candidate",
  async () => {
    const target = targetRule(
      "target-1",
      30 * 60_000,
    );

    const current = Array.from(
      { length: 30 },
      (_, index) =>
        candidate(
          `current-${index}`,
          60_000,
        ),
    );

    const blocked = candidate(
      "liked-blocked",
      60_000,
    );

    const allowed = candidate(
      "liked-allowed",
      60_000,
    );

    const blockedKey =
      lastFmMusicIdentityKey(
        blocked.title,
        blocked.primaryArtistName,
      );

    assert.ok(blockedKey);

    const pools = {
      music: [...current],
      podcasts: [] as Candidate[],
    };

    const musicPoolByTargetId =
      new Map<string, Candidate[]>([
        ["target-1", current],
      ]);

    const plan = planRun({
      pools,
      targets: [target],
      musicPoolByTargetId,
    });

    const state = {
      userId: "user-1",
      simulate: true,

      context: {
        enabled: false,
        windowValue: null,
        windowUnit: null,
        cutoff: null,
        historyKnownSince: null,
        lastSyncAt: null,
        blockedTrackIds:
          new Set<string>(),
      },

      initialSync: {
        enabled: false,
        eventsRead: 0,
        identitiesUpdated: 0,
        listeningEventsInserted: 0,
        listeningEventsDuplicateCount: 0,
        listeningEventsSuppressedByHandoff: 0,
        historyKnownSince: null,
        lastSyncAt: null,
      },

      repeatCompliance: {
        allowed: false,
      },

      recentlyPlayedSkippedCount: 0,
      missingTrackIdentitySkippedCount: 0,

      preWriteSync: null,
      preWriteRevalidated: false,
      preWriteBlockedCount: 0,
      preWriteMissingIdentityCount: 0,

      lastFmFactualCooldown: {
        configuredMode: "ACTIVE",
        effectiveMode: "ACTIVE",
        status: "READY_ACTIVE",
        productiveInfluenceAllowed: true,

        windowValue: 6,
        windowUnit: "MONTHS",

        cutoff:
          new Date(
            "2026-03-28T00:00:00.000Z",
          ),

        asOf:
          new Date(
            "2026-09-28T00:00:00.000Z",
          ),

        blockedIdentityKeys:
          new Set([blockedKey]),

        localScrobbleCount: 1,
        providerScrobbleCount: 0,

        providerRequestedFrom: null,
        providerRequestedTo: null,

        providerPagesFetched: 0,
        providerTotalPages: 0,
        providerComplete: true,

        matchedCandidateCount: 0,
        skippedCandidateCount: 0,

        preWriteRevalidated: true,
        preWriteBlockedCount: 0,

        failure: null,
      },

      music07Eligibility: undefined,

      firstPartyPlaybackPreferences: [],
      firstPartyPreferenceEvidence: null,

      likedTrackSourceShadow: {
        productivePilot: {},
      },
    } as unknown as MusicRepeatRunState;

    const prepared:
      PreparedLikedTrackSourceShadow = {
        enabled: false,
        targetIds: new Set(),

        candidates: [
          blocked,
          allowed,
        ],

        plannerPilotEnabled: true,

        plannerPilotTargetIds:
          new Set(["target-1"]),
      };

    await runWithMusicRepeatState(
      state,
      async () => {
        applyLikedTrackSourceShadowForCurrentRun(
          prepared,
          {
            pools,
            plan,
            targets: [target],
            musicPoolByTargetId,
          },
        );

        return null;
      },
    );

    const summary =
      state.likedTrackSourceShadow as
        | {
            productivePilot?: Record<
              string,
              unknown
            >;
          }
        | null;

    const pilot =
      summary?.productivePilot ?? {};

    assert.equal(
      pilot.canonicalEligibilityApplied,
      true,
    );

    assert.equal(
      pilot.eligibilityInputCandidates,
      2,
    );

    assert.equal(
      pilot.eligibilityEligibleCandidates,
      1,
    );

    assert.equal(
      pilot.eligibilityBlockedCandidates,
      1,
    );

    assert.equal(
      pilot.lastFmFactualBlockedCandidates,
      1,
    );

    assert.equal(
      state.lastFmFactualCooldown
        ?.matchedCandidateCount,
      1,
    );

    assert.equal(
      state.lastFmFactualCooldown
        ?.skippedCandidateCount,
      1,
    );

    assert.equal(
      plan.targets[0]!.result.items.some(
        (item) =>
          item.spotifyTrackId ===
          blocked.spotifyTrackId,
      ),
      false,
    );

    assert.equal(
      plan.targets[0]!.result.items.some(
        (item) =>
          item.spotifyTrackId ===
          allowed.spotifyTrackId,
      ),
      true,
    );

    assert.equal(
      pilot.status,
      "APPLIED",
    );

    assert.equal(
      pilot.plannerInfluence,
      true,
    );
  },
);

function candidate(
  id: string,
  durationMs: number,
): Candidate {
  return {
    uri: `spotify:track:${id}`,
    type: "MUSIC",
    title: `Track ${id}`,
    spotifyTrackId: id,

    primaryArtistId:
      `artist-${id}`,

    primaryArtistName:
      `Artist ${id}`,

    albumId:
      `album-${id}`,

    albumName:
      `Album ${id}`,

    durationMs,
  };
}

function targetRule(
  id: string,
  targetDurationMs: number,
): RunTarget {
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
