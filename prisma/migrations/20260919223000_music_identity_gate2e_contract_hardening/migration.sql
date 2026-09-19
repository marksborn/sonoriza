-- MUSIC-IDENTITY-01 Gate 2E — provider-scope + user lifecycle hardening.
--
-- Shadow-only contract hardening. Existing provider refs are conservatively
-- assigned to the Sonoriza-owned "global" namespace. No canonical association,
-- execution status, lineage, planner decision or playback behavior is changed.
--
-- The original provider-ID unique indexes intentionally remain in place as a
-- stricter compatibility guard. Scoped uniqueness is added now, but relaxing
-- the legacy guard requires a future explicit provider rollout gate.

ALTER TABLE "ArtistProviderRef"
  ADD COLUMN "providerScope" TEXT NOT NULL DEFAULT 'global';

ALTER TABLE "TrackProviderRef"
  ADD COLUMN "providerScope" TEXT NOT NULL DEFAULT 'global';

ALTER TABLE "AlbumReleaseProviderRef"
  ADD COLUMN "providerScope" TEXT NOT NULL DEFAULT 'global';

ALTER TABLE "ArtistProviderRef"
  ADD CONSTRAINT "ArtistProviderRef_providerScope_check" CHECK (
    btrim("providerScope") <> ''
    AND "providerScope" = lower(btrim("providerScope"))
  );

ALTER TABLE "TrackProviderRef"
  ADD CONSTRAINT "TrackProviderRef_providerScope_check" CHECK (
    btrim("providerScope") <> ''
    AND "providerScope" = lower(btrim("providerScope"))
  );

ALTER TABLE "AlbumReleaseProviderRef"
  ADD CONSTRAINT "AlbumReleaseProviderRef_providerScope_check" CHECK (
    btrim("providerScope") <> ''
    AND "providerScope" = lower(btrim("providerScope"))
  );

CREATE UNIQUE INDEX "ArtistProviderRef_userId_provider_providerScope_providerArtistId_key"
  ON "ArtistProviderRef"("userId", "provider", "providerScope", "providerArtistId");
CREATE INDEX "ArtistProviderRef_userId_provider_providerScope_idx"
  ON "ArtistProviderRef"("userId", "provider", "providerScope");

CREATE UNIQUE INDEX "TrackProviderRef_userId_provider_providerScope_providerTrackId_key"
  ON "TrackProviderRef"("userId", "provider", "providerScope", "providerTrackId");
CREATE INDEX "TrackProviderRef_userId_provider_providerScope_idx"
  ON "TrackProviderRef"("userId", "provider", "providerScope");

CREATE UNIQUE INDEX "AlbumReleaseProviderRef_userId_provider_providerScope_providerAlbumId_key"
  ON "AlbumReleaseProviderRef"("userId", "provider", "providerScope", "providerAlbumId");
CREATE INDEX "AlbumReleaseProviderRef_userId_provider_providerScope_idx"
  ON "AlbumReleaseProviderRef"("userId", "provider", "providerScope");

-- Every canonical row is explicitly owned by a real Sonoriza user. Internal
-- canonical graph relations remain RESTRICT: deleting a user cleans the graph,
-- while deleting an individual canonical parent remains an explicit operation.
ALTER TABLE "ArtistIdentity"
  ADD CONSTRAINT "ArtistIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SongIdentity"
  ADD CONSTRAINT "SongIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RecordingIdentity"
  ADD CONSTRAINT "RecordingIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlbumIdentity"
  ADD CONSTRAINT "AlbumIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlbumReleaseIdentity"
  ADD CONSTRAINT "AlbumReleaseIdentity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ArtistProviderRef"
  ADD CONSTRAINT "ArtistProviderRef_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrackProviderRef"
  ADD CONSTRAINT "TrackProviderRef_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AlbumReleaseProviderRef"
  ADD CONSTRAINT "AlbumReleaseProviderRef_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
