-- PODCAST-01: native Spotify "Your Episodes" source and per-source playback policy.
ALTER TYPE "SpotifySourceType" ADD VALUE 'SAVED_EPISODES';

ALTER TABLE "SourcePlaylist"
ADD COLUMN "includePlayed" BOOLEAN NOT NULL DEFAULT false;
