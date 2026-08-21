import { getProjectedBatchedCompleteMusicDiscoveryProfile } from "./complete-profile-projected";
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
 * The canonical aggregator also returns several derived/sorted views over the
 * same COMPLETE artist/track objects. Runtime scoring only needs the canonical
 * historical artist/track universes plus small profile context. Retaining the
 * full report here would keep those redundant arrays alive through identities,
 * source collection and scoring, so only the small context is retained.
 */
export async function getCompleteMusicDiscoveryProfile(
  userId: string,
  options: Omit<MusicDiscoveryProfileOptions, "topN" | "completeUniverse"> = {},
): Promise<CompleteMusicDiscoveryProfile> {
  const fullProfile = await getProjectedBatchedCompleteMusicDiscoveryProfile(
    userId,
    options,
  );

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
