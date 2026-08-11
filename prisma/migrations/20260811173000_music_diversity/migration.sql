ALTER TABLE "TargetPlaylist"
  ADD COLUMN "maxTracksPerArtist" INTEGER,
  ADD COLUMN "maxTracksPerAlbum" INTEGER;

ALTER TABLE "TargetPlaylist"
  ADD CONSTRAINT "TargetPlaylist_maxTracksPerArtist_check"
  CHECK ("maxTracksPerArtist" IS NULL OR "maxTracksPerArtist" BETWEEN 1 AND 50),
  ADD CONSTRAINT "TargetPlaylist_maxTracksPerAlbum_check"
  CHECK ("maxTracksPerAlbum" IS NULL OR "maxTracksPerAlbum" BETWEEN 1 AND 50);
