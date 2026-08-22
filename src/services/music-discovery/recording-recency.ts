import type { DiscoveryTrackProfile } from "./profile";
import type { DiscoveryTrackIdentityEvidence } from "./track-identity";

export type RecordingIdentityMatch = (
  a: RecordingIdentityTrack,
  b: RecordingIdentityTrack,
) => unknown | null;

export type RecordingIdentityTrack = Pick<
  DiscoveryTrackProfile,
  "spotifyTrackId" | "trackName" | "artistName"
> & {
  evidence: DiscoveryTrackIdentityEvidence | null;
};

export type RecordingRecencyNormalizationResult = {
  tracks: DiscoveryTrackProfile[];
  evidence: {
    policy: "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN";
    adjustedLastPlayedCount: number;
    adjustedCooldownLastPlayedCount: number;
    adjustedCooldownEligibilityCount: number;
  };
};

/**
 * Spotify may expose the same recording under multiple track IDs because of
 * releases, licensing and market relinking. DISCOVERY must not treat an old ID
 * as dormant when an equivalent recording ID was observed recently.
 *
 * This deliberately propagates only recency/cooldown facts. Historical play
 * counts remain attached to their observed Spotify IDs; downstream recording
 * identity arbitration still owns cross-release dedupe/selection.
 */
export function normalizeRecordingRecency(input: {
  tracks: DiscoveryTrackProfile[];
  trackIdentities: DiscoveryTrackIdentityEvidence[];
  match: RecordingIdentityMatch;
}): RecordingRecencyNormalizationResult {
  if (input.tracks.length < 2) {
    return {
      tracks: input.tracks,
      evidence: {
        policy: "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN",
        adjustedLastPlayedCount: 0,
        adjustedCooldownLastPlayedCount: 0,
        adjustedCooldownEligibilityCount: 0,
      },
    };
  }

  const identityByTrackId = new Map(
    input.trackIdentities.map((row) => [row.spotifyTrackId, row] as const),
  );
  const titleIndex = new Map<string, DiscoveryTrackProfile[]>();
  const isrcIndex = new Map<string, DiscoveryTrackProfile[]>();

  for (const track of input.tracks) {
    pushIndex(titleIndex, normalized(track.trackName), track);
    const identity = identityByTrackId.get(track.spotifyTrackId);
    if (identity?.isrc && !identity.isrcConflict) {
      pushIndex(isrcIndex, identity.isrc, track);
    }
  }

  let adjustedLastPlayedCount = 0;
  let adjustedCooldownLastPlayedCount = 0;
  let adjustedCooldownEligibilityCount = 0;

  const tracks = input.tracks.map((track) => {
    const currentIdentity = asIdentityTrack(track, identityByTrackId);
    const possible = new Map<string, DiscoveryTrackProfile>();
    possible.set(track.spotifyTrackId, track);

    for (const row of titleIndex.get(normalized(track.trackName)) ?? []) {
      possible.set(row.spotifyTrackId, row);
    }
    const currentEvidence = identityByTrackId.get(track.spotifyTrackId);
    if (currentEvidence?.isrc && !currentEvidence.isrcConflict) {
      for (const row of isrcIndex.get(currentEvidence.isrc) ?? []) {
        possible.set(row.spotifyTrackId, row);
      }
    }

    const equivalent = [...possible.values()].filter(
      (row) =>
        row.spotifyTrackId === track.spotifyTrackId ||
        input.match(currentIdentity, asIdentityTrack(row, identityByTrackId)) !== null,
    );

    let effectiveLastPlayedAt = track.lastPlayedAt;
    let effectiveCooldownLastPlayedAt =
      track.cooldownLastPlayedAt ?? track.lastPlayedAt;
    let effectiveCooldownEligible = track.cooldownEligible;

    for (const row of equivalent) {
      const rowObservedAt = maxDate(
        row.lastPlayedAt,
        row.cooldownLastPlayedAt ?? row.lastPlayedAt,
      );
      effectiveLastPlayedAt = maxDate(effectiveLastPlayedAt, rowObservedAt);
      effectiveCooldownLastPlayedAt = maxDate(
        effectiveCooldownLastPlayedAt,
        rowObservedAt,
      );
      effectiveCooldownEligible = combineCooldownEligibility(
        effectiveCooldownEligible,
        row.cooldownEligible,
      );
    }

    if (effectiveLastPlayedAt.getTime() !== track.lastPlayedAt.getTime()) {
      adjustedLastPlayedCount += 1;
    }
    if (
      effectiveCooldownLastPlayedAt.getTime() !==
      (track.cooldownLastPlayedAt ?? track.lastPlayedAt).getTime()
    ) {
      adjustedCooldownLastPlayedCount += 1;
    }
    if (effectiveCooldownEligible !== track.cooldownEligible) {
      adjustedCooldownEligibilityCount += 1;
    }

    if (
      effectiveLastPlayedAt.getTime() === track.lastPlayedAt.getTime() &&
      effectiveCooldownLastPlayedAt.getTime() ===
        (track.cooldownLastPlayedAt ?? track.lastPlayedAt).getTime() &&
      effectiveCooldownEligible === track.cooldownEligible
    ) {
      return track;
    }

    return {
      ...track,
      lastPlayedAt: effectiveLastPlayedAt,
      cooldownLastPlayedAt: effectiveCooldownLastPlayedAt,
      cooldownEligible: effectiveCooldownEligible,
    };
  });

  return {
    tracks,
    evidence: {
      policy: "MAX_EQUIVALENT_LAST_PLAYED_AND_COOLDOWN",
      adjustedLastPlayedCount,
      adjustedCooldownLastPlayedCount,
      adjustedCooldownEligibilityCount,
    },
  };
}

function asIdentityTrack(
  track: DiscoveryTrackProfile,
  identityByTrackId: Map<string, DiscoveryTrackIdentityEvidence>,
): RecordingIdentityTrack {
  return {
    spotifyTrackId: track.spotifyTrackId,
    trackName: track.trackName,
    artistName: track.artistName,
    evidence: identityByTrackId.get(track.spotifyTrackId) ?? null,
  };
}

function combineCooldownEligibility(
  a: boolean | null,
  b: boolean | null,
): boolean | null {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

function pushIndex<T>(map: Map<string, T[]>, key: string, value: T): void {
  if (!key) return;
  const rows = map.get(key);
  if (rows) rows.push(value);
  else map.set(key, [value]);
}

function maxDate(a: Date, b: Date): Date {
  return a >= b ? a : b;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}
