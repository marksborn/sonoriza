import { getBatchedCompleteMusicDiscoveryProfile } from "./complete-profile-batched";
import type {
  DiscoveryArtistProfile,
  DiscoveryTrackProfile,
  MusicDiscoveryProfile,
  MusicDiscoveryProfileOptions,
} from "./profile";

export type CompleteMusicDiscoveryProfile = {
  universe: "COMPLETE";
  profile: MusicDiscoveryProfile;
  artists: DiscoveryArtistProfile[];
  tracks: DiscoveryTrackProfile[];
};

/**
 * Gate 3B selection input. Unlike diagnostic score reports, this path asks the
 * Gate 1.1 canonical aggregator to retain every artist and every Spotify track
 * identity before Gate 2.2 scoring is allowed to declare the universe COMPLETE.
 *
 * PERF-01 keeps that COMPLETE contract while reading listening history in
 * bounded pages instead of materializing the full event timeline in Node.
 */
export async function getCompleteMusicDiscoveryProfile(
  userId: string,
  options: Omit<MusicDiscoveryProfileOptions, "topN" | "completeUniverse"> = {},
): Promise<CompleteMusicDiscoveryProfile> {
  const profile = await getBatchedCompleteMusicDiscoveryProfile(userId, options);

  return {
    universe: "COMPLETE",
    profile,
    artists: profile.topArtistsHistorical,
    tracks: profile.topTracksHistorical,
  };
}
