import { getProjectedBatchedRetainedCompleteMusicDiscoveryProfile } from "./complete-profile-projected";
import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
  MusicDiscoveryProfile,
  MusicDiscoveryProfileOptions,
} from "./profile";

export type CompleteMusicDiscoveryContext = Pick<
  MusicDiscoveryProfile,
  "generatedAt" | "heuristics" | "coverage" | "cooldown"
>;

export type CompleteMusicDiscoveryProfile = {
  universe: "COMPLETE";
  profile: CompleteMusicDiscoveryContext;
  artists: DiscoveryArtistProfile[];
  tracks: DiscoveryTrackProfile[];
};

/**
 * Gate 3B selection input. Unlike diagnostic score reports, this path asks the
 * Gate 1.1 canonical aggregator to retain every artist and every Spotify track
 * identity before Gate 2.2 scoring is allowed to declare the universe COMPLETE.
 *
 * PERF-01 keeps that COMPLETE contract while reading listening history in
 * bounded pages and projecting only the Extended History facts the canonical
 * aggregator actually consumes.
 *
 * Runtime scoring only needs the canonical historical artist/track universes
 * plus small profile context. The runtime loader therefore uses the lean
 * COMPLETE finalizer and never allocates the redundant diagnostic/window/
 * candidate views produced by the full canonical report.
 */
export async function getCompleteMusicDiscoveryProfile(
  userId: string,
  options: Omit<MusicDiscoveryProfileOptions, "topN" | "completeUniverse"> = {},
): Promise<CompleteMusicDiscoveryProfile> {
  const retainedProfile =
    await getProjectedBatchedRetainedCompleteMusicDiscoveryProfile(
      userId,
      options,
    );

  return {
    universe: "COMPLETE",
    profile: {
      generatedAt: retainedProfile.generatedAt,
      heuristics: retainedProfile.heuristics,
      coverage: retainedProfile.coverage,
      cooldown: retainedProfile.cooldown,
    },
    artists: retainedProfile.topArtistsHistorical,
    tracks: retainedProfile.topTracksHistorical,
  };
}

export function retainCompleteMusicDiscoveryProfile(
  fullProfile: MusicDiscoveryProfile,
): CompleteMusicDiscoveryProfile {
  return {
    universe: "COMPLETE",
    profile: {
      generatedAt: fullProfile.generatedAt,
      heuristics: fullProfile.heuristics,
      coverage: fullProfile.coverage,
      cooldown: fullProfile.cooldown,
    },
    artists: fullProfile.topArtistsHistorical,
    tracks: fullProfile.topTracksHistorical,
  };
}
