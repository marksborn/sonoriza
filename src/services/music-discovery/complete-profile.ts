import {
  getMusicDiscoveryProfile,
  type DiscoveryArtistProfile,
  type DiscoveryTrackProfile,
  type MusicDiscoveryProfile,
  type MusicDiscoveryProfileOptions,
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
 */
export async function getCompleteMusicDiscoveryProfile(
  userId: string,
  options: Omit<MusicDiscoveryProfileOptions, "topN" | "completeUniverse"> = {},
): Promise<CompleteMusicDiscoveryProfile> {
  const profile = await getMusicDiscoveryProfile(userId, {
    ...options,
    completeUniverse: true,
  });

  return {
    universe: "COMPLETE",
    profile,
    artists: profile.topArtistsHistorical,
    tracks: profile.topTracksHistorical,
  };
}