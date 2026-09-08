-- PODCAST-06 Gate 4I — persist source-independent Spotify show provenance.
-- No backfill is performed here; existing rows remain unknown until observed
-- again with authoritative provider metadata.

ALTER TABLE "EpisodeListeningState"
  ADD COLUMN "spotifyShowId" TEXT;

CREATE INDEX "EpisodeListeningState_userId_spotifyShowId_idx"
ON "EpisodeListeningState"("userId", "spotifyShowId");
