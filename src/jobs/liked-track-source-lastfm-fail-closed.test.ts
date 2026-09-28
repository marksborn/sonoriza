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
  runWithMusicRepeatState,
  type MusicRepeatRunState,
} from "./music-repeat-runtime";

test(
  "Gate 5B4 abstains and preserves baseline when ACTIVE Last.fm is unavailable",
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

    const liked = candidate(
      "liked-exclusive",
      60_000,
    );

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

    const baselineUris =
      plan.targets[0]!.result.items.map(
        (item) => item.uri,
      );

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
        effectiveMode: "SHADOW",
        status: "PROVIDER_UNAVAILABLE",
        productiveInfluenceAllowed: false,

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
          new Set<string>(),

        localScrobbleCount: 1572,
        providerScrobbleCount: 0,

        providerRequestedFrom:
          new Date(
            "2026-08-14T00:00:00.000Z",
          ),

        providerRequestedTo:
          new Date(
            "2026-09-28T00:00:00.000Z",
          ),

        providerPagesFetched: 0,
        providerTotalPages: 0,
        providerComplete: false,

        matchedCandidateCount: 0,
        skippedCandidateCount: 0,

        preWriteRevalidated: false,
        preWriteBlockedCount: 0,

        failure:
          "Last.fm returned invalid JSON (500)",
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

        candidates: [liked],

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
      pilot.status,
      "ABSTAINED",
    );

    assert.equal(
      pilot.reason,
      "LASTFM_FACTUAL_ACTIVE_NOT_READY",
    );

    assert.equal(
      pilot.attempted,
      false,
    );

    assert.equal(
      pilot.plannerInfluence,
      false,
    );

    assert.equal(
      pilot.appliedToAuthoritativePlan,
      false,
    );

    assert.equal(
      pilot.canonicalEligibilityApplied,
      false,
    );

    assert.equal(
      pilot.lastFmProductiveGateRequired,
      true,
    );

    assert.equal(
      pilot.lastFmProductiveGatePassed,
      false,
    );

    assert.equal(
      pilot.lastFmStatus,
      "PROVIDER_UNAVAILABLE",
    );

    assert.equal(
      pilot.lastFmEffectiveMode,
      "SHADOW",
    );

    assert.equal(
      pilot.lastFmProviderComplete,
      false,
    );

    assert.equal(
      pilot.lastFmProductiveInfluenceAllowed,
      false,
    );

    assert.equal(
      pilot.lastFmFailure,
      "Last.fm returned invalid JSON (500)",
    );

    assert.deepEqual(
      plan.targets[0]!.result.items.map(
        (item) => item.uri,
      ),
      baselineUris,
    );

    assert.equal(
      plan.targets[0]!.result.items.some(
        (item) =>
          item.spotifyTrackId ===
          liked.spotifyTrackId,
      ),
      false,
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
